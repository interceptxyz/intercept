/**
 * API Playground.
 *
 *  - sandboxEvaluate: the production engine (decode → simulate → price → firewall → risk → decision)
 *    with nothing recorded: no evaluation row, no approval, no alert, no webhook, no feed entry and
 *    no execution authorization. Production spending counters are read, never written.
 *  - buildTransaction: unsigned test transactions from structured fields. Never signed or sent.
 *  - executor: runs one request against an allowlisted Intercept route, in process (no outbound
 *    HTTP), with a timeout, and keeps a redacted history per organization and user.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import { Db, one, q } from '../db';
import { HttpError, bad, dec, decStr, isBase58Address, newId, notFound } from '../lib/util';
import { DEFAULT_POLICY, PolicyConfig, parsePolicy } from '../policy/schema';
import { DecodeError, parseTransaction } from '../solana/decode';
import { Network, connection, parseMintDecimals, rpc } from '../solana/rpc';
import { PROGRAMS, WSOL_MINT } from '../solana/programs';
import { buildContext } from '../engine/context';
import { History, decide, firewallChecks, riskChecks, systemChecks } from '../engine/checks';
import { getPrices } from '../market/prices';
import { agentHistory, decodedView, simulationView } from './evaluations';
import { evaluateIntel, networkCheck } from '../network/matching';
import { publicSummary } from '../network/service';

// ------------------------------------------------------------------------------ sandbox marker

/** Random per process: only requests injected by the executor carry it, so it cannot be forged. */
const NONCE = randomBytes(24).toString('hex');
const MARK = 'x-icpt-playground';
export function isPlayground(req: FastifyRequest) {
  const v = req.headers[MARK];
  return typeof v === 'string' && v.length === NONCE.length && timingSafeEqual(Buffer.from(v), Buffer.from(NONCE));
}

export const NOTICE = 'Playground result. Nothing was recorded as production activity, no spending counter changed, and no execution authorization was issued. Nothing was signed or broadcast.';

// ------------------------------------------------------------------------------ sandbox evaluate

const usd = z.string().regex(/^\d{1,15}(\.\d{1,9})?$/, 'decimal string in USD, e.g. "1500"');
const addr = z.string().refine(isBase58Address, 'address (base58)');
const network = z.enum(['mainnet-beta', 'devnet']);

export const sandboxSchema = z.object({
  transaction: z.string().min(80).max(2000),
  agentId: z.string().max(40).optional(),
  network: network.optional(),
  wallet: addr.optional(),
  policy: z.unknown().optional(),
  assume: z.object({ dailySpendUsd: usd.optional() }).strict().optional(),
  kind: z.enum(['evaluate', 'execution_request']).default('evaluate'),
}).strict();

export interface SandboxInput {
  orgId: string; transaction: string; agentId?: string | null; network?: Network; wallet?: string | null;
  policy?: unknown; assume?: { dailySpendUsd?: string }; kind: 'evaluate' | 'execution_request'; via: 'console_session' | 'api_key';
}

export async function sandboxEvaluate(db: Db, i: SandboxInput) {
  const t0 = Date.now();
  let agent: any = null;
  if (i.agentId) {
    agent = await one(db, 'SELECT a.*, o.emergency_stop FROM agents a JOIN organizations o ON o.id = a.org_id WHERE a.id = $1 AND a.org_id = $2', [i.agentId, i.orgId]);
    if (!agent) throw notFound('Agent');
    if (i.kind === 'execution_request' && agent.integration_mode !== 'ENFORCED_EXECUTION') throw new HttpError(409, 'NOT_ENFORCED', 'This agent is in EVALUATION mode; switch it to ENFORCED_EXECUTION to request execution authorizations.');
  }

  let policy: PolicyConfig, policySource: 'custom' | 'agent' | 'default';
  if (i.policy !== undefined) {
    const p = parsePolicy(i.policy);
    if (!p.ok) throw bad('INVALID_POLICY', 'The test policy configuration is invalid.', p.issues);
    policy = p.config; policySource = 'custom';
  } else if (agent) {
    const pv = await one(db, 'SELECT config FROM policy_versions WHERE policy_id = $1 AND version = $2 AND org_id = $3', [agent.policy_id, agent.policy_version, i.orgId]);
    if (!pv) throw new HttpError(409, 'NO_POLICY', 'The agent has no active policy version.');
    const p = parsePolicy(pv.config);
    if (!p.ok) throw new HttpError(500, 'POLICY_INVALID', 'Stored policy is invalid.');
    policy = p.config; policySource = 'agent';
  } else { policy = DEFAULT_POLICY; policySource = 'default'; }

  let vtx;
  try { vtx = parseTransaction(i.transaction); } catch (e) {
    if (e instanceof DecodeError) throw bad(`TX_${e.code}`, e.message);
    throw e;
  }
  const net: Network = agent ? agent.network : i.network ?? 'mainnet-beta';
  const wallet: string | null = agent ? agent.wallet : i.wallet ?? null;
  const ctx = await buildContext(vtx, { conn: connection(net), network: net, wallet, runSimulation: true });

  // spending history: an explicit test assumption, the agent's real 24 h (read only), or none
  let h: History, historySource: 'assumed' | 'agent_24h' | 'none';
  if (i.assume?.dailySpendUsd !== undefined) { h = { dailySpendUsd: dec(i.assume.dailySpendUsd), protocolSpendUsd: {} }; historySource = 'assumed'; }
  else if (agent) { h = await agentHistory(db, agent.id, ctx.decoded.programs); historySource = 'agent_24h'; }
  else { h = { dailySpendUsd: 0n, protocolSpendUsd: {} }; historySource = 'none'; }

  const state = agent
    ? { status: agent.status, mode: agent.integration_mode, walletVerified: !!agent.wallet_verified_at, orgEmergencyStop: agent.emergency_stop }
    : { status: 'ACTIVE' as const, mode: 'EVALUATION' as const, walletVerified: false, orgEmergencyStop: false };
  // shared intelligence is read, never written: no match record, no observation, no alert
  const intel = await evaluateIntel(db, net, ctx, policy, publicSummary);
  const checks = [...systemChecks(state), ...firewallChecks(ctx, policy), networkCheck(intel, policy), ...riskChecks(ctx, policy, h)];
  const { decision, reasons } = decide(checks);
  return {
    id: newId('pg'), object: 'evaluation', sandbox: true, notice: NOTICE,
    agentId: agent?.id ?? null, kind: i.kind, source: 'playground', via: i.via, network: net,
    environment: net === 'mainnet-beta' ? 'live' : 'test', createdAt: new Date().toISOString(),
    decision, effectiveDecision: decision, reasons,
    policy: { source: policySource, id: policySource === 'agent' ? agent.policy_id : null, version: policySource === 'agent' ? agent.policy_version : null, config: policy },
    history: { source: historySource, dailySpendUsd: h.dailySpendUsd === null ? null : decStr(h.dailySpendUsd, 2) },
    valueUsd: ctx.valueUsd === null ? null : decStr(ctx.valueUsd, 2), valueCertain: ctx.valueUsd !== null && ctx.flowSource === 'simulation',
    messageHash: ctx.decoded.messageHash, approval: null, authorization: null,
    checks: { risk: checks.filter((x) => x.category === 'RISK'), security: checks.filter((x) => x.category !== 'RISK') },
    decoded: decodedView(ctx), simulation: simulationView(ctx, net), intelligence: intel, latencyMs: Date.now() - t0,
  };
}

// ------------------------------------------------------------------------------ transaction builder

const hex = z.string().regex(/^(0x)?([0-9a-fA-F]{2}){0,512}$/, 'hex bytes');
const amount = z.string().regex(/^\d{1,20}(\.\d{1,12})?$/, 'decimal string');
export const buildSchema = z.object({
  network: network.default('mainnet-beta'),
  type: z.enum(['native_transfer', 'token_transfer', 'token_approve', 'swap', 'program_call']),
  from: addr,
  to: addr.optional(),                         // recipient, or delegate for token_approve
  mint: addr.optional(),                       // token_transfer / token_approve / swap input
  outputMint: addr.optional(),                 // swap output
  amount: amount.optional(),                   // in token units (SOL for native)
  amountUsd: usd.optional(),                   // converted at the current market price
  unlimited: z.boolean().default(false),       // token_approve: u64 max allowance
  slippageBps: z.number().int().min(1).max(5000).default(50),
  programId: addr.optional(),
  data: hex.optional(),
  accounts: z.array(z.object({ pubkey: addr, isSigner: z.boolean().default(false), isWritable: z.boolean().default(false) }).strict()).max(16).default([]),
  computeUnitLimit: z.number().int().min(200).max(1_400_000).optional(),
  computeUnitPriceMicroLamports: z.number().int().min(0).max(100_000_000).optional(),
  memo: z.string().max(120).optional(),
}).strict();
export type BuildInput = z.infer<typeof buildSchema>;

const U64_MAX = (1n << 64n) - 1n;
const ata = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], new PublicKey(PROGRAMS.ATA))[0];
const u64le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

let jupFetch: (url: string, init?: any) => Promise<any> = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
export function setJupiterFetch(f: typeof jupFetch) { jupFetch = f; }
const JUP = process.env.JUPITER_SWAP_API ?? 'https://lite-api.jup.ag/swap/v1';
/** The route provider throttles bursts per IP (shared on serverless): retry 429s with a short backoff. */
async function jup(url: string, init?: any) {
  let r: any = null;
  for (const wait of [0, 1200, 2500]) {
    if (wait) await new Promise((res) => setTimeout(res, wait));
    r = await jupFetch(url, init).catch(() => null);
    if (r && r.status !== 429) return r;
  }
  return r;
}

async function mintInfo(conn: any, mint: string) {
  if (mint === WSOL_MINT) return { program: PROGRAMS.TOKEN, decimals: 9 };
  const info = await rpc('getAccountInfo(mint)', () => conn.getAccountInfo(new PublicKey(mint), 'confirmed'));
  if (!info) throw bad('MINT_NOT_FOUND', `No token mint at ${mint} on this network.`);
  const program = (info as any).owner.toBase58();
  const decimals = parseMintDecimals(program, Buffer.from((info as any).data));
  if (decimals === null) throw bad('NOT_A_MINT', `${mint} is not a token mint.`);
  return { program, decimals };
}

/** Units → base units, from an explicit amount or a USD amount at the current price. */
async function toRaw(b: BuildInput, mint: string, decimals: number) {
  if (b.amount !== undefined) {
    const [w, f = ''] = b.amount.split('.');
    if (f.length > decimals) throw bad('TOO_MANY_DECIMALS', `This token has ${decimals} decimals.`);
    return { raw: BigInt(w + f.padEnd(decimals, '0')), price: null };
  }
  if (b.amountUsd === undefined) throw bad('AMOUNT_REQUIRED', 'Give an amount (token units) or amountUsd.');
  const { prices, errors } = await getPrices([mint], b.network);
  const p = prices.get(mint);
  if (!p) throw new HttpError(503, 'PRICE_UNAVAILABLE', `No market price for ${mint}: ${errors.join('; ') || 'not listed'}.`);
  const raw = (dec(b.amountUsd) * 10n ** BigInt(decimals)) / p.usd;
  return { raw, price: { usd: p.usdStr, slot: p.slot, source: p.source, reference: p.reference } };
}
const units = (raw: bigint, d: number) => { const s = raw.toString().padStart(d + 1, '0'); return d ? `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '') : s; };

export async function buildTransaction(b: BuildInput) {
  const conn = connection(b.network);
  const from = new PublicKey(b.from);
  const ixs: TransactionInstruction[] = [];
  if (b.computeUnitLimit) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: b.computeUnitLimit }));
  if (b.computeUnitPriceMicroLamports !== undefined) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: b.computeUnitPriceMicroLamports }));
  const summary: Record<string, unknown> = { type: b.type, network: b.network, from: b.from };

  if (b.type === 'swap') {
    if (!b.mint || !b.outputMint) throw bad('MINTS_REQUIRED', 'A swap needs mint (input) and outputMint.');
    if (b.network !== 'mainnet-beta') throw bad('SWAP_MAINNET_ONLY', 'Swap routes are only available on mainnet.');
    const m = await mintInfo(conn, b.mint);
    const { raw, price } = await toRaw(b, b.mint, m.decimals);
    const upstream = (r: any, what: string) => r?.status === 429
      ? new HttpError(503, 'UPSTREAM_RATE_LIMITED', `The swap route provider is rate limiting requests; retry in a minute. (${what})`)
      : new HttpError(503, 'ROUTE_UNAVAILABLE', `${what} (${r ? 'HTTP ' + r.status : 'network error'}).`);
    const quoteRes = await jup(`${JUP}/quote?inputMint=${b.mint}&outputMint=${b.outputMint}&amount=${raw}&slippageBps=${b.slippageBps}`);
    if (!quoteRes?.ok) throw upstream(quoteRes, 'No swap route available');
    const quote = await quoteRes.json();
    const swapRes = await jup(`${JUP}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: b.from, wrapAndUnwrapSol: b.mint === WSOL_MINT || b.outputMint === WSOL_MINT, dynamicComputeUnitLimit: true }) });
    if (!swapRes?.ok) throw upstream(swapRes, 'The swap transaction could not be built');
    const { swapTransaction } = await swapRes.json();
    if (typeof swapTransaction !== 'string') throw new HttpError(503, 'ROUTE_UNAVAILABLE', 'The swap transaction could not be built.');
    if (swapTransaction.length > 2000) throw new HttpError(422, 'TX_TOO_LARGE', 'The routed swap is too large for one evaluation request.');
    return { transaction: swapTransaction, summary: { ...summary, mint: b.mint, outputMint: b.outputMint, amountRaw: raw.toString(), amount: units(raw, m.decimals), expectedOut: quote.outAmount, slippageBps: b.slippageBps, route: (quote.routePlan ?? []).map((r: any) => r.swapInfo?.label).filter(Boolean), price }, signed: false };
  }

  if (b.type === 'native_transfer') {
    if (!b.to) throw bad('RECIPIENT_REQUIRED', 'Give a recipient address (to).');
    const { raw, price } = await toRaw(b, WSOL_MINT, 9);
    if (raw <= 0n) throw bad('AMOUNT_ZERO', 'The amount must be positive.');
    ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(b.to), lamports: raw }));
    Object.assign(summary, { to: b.to, asset: 'native', amountRaw: raw.toString(), amount: units(raw, 9), price });
  }

  if (b.type === 'token_transfer' || b.type === 'token_approve') {
    if (!b.mint) throw bad('MINT_REQUIRED', 'Give the token mint.');
    if (!b.to) throw bad('RECIPIENT_REQUIRED', b.type === 'token_approve' ? 'Give the delegate address (to).' : 'Give a recipient address (to).');
    const m = await mintInfo(conn, b.mint);
    const program = new PublicKey(m.program), mint = new PublicKey(b.mint), to = new PublicKey(b.to);
    const source = ata(from, mint, program);
    let raw: bigint, price: unknown = null;
    if (b.type === 'token_approve' && b.unlimited) raw = U64_MAX;
    else ({ raw, price } = await toRaw(b, b.mint, m.decimals));
    if (raw <= 0n || raw > U64_MAX) throw bad('AMOUNT_RANGE', 'The amount is out of range.');
    if (b.type === 'token_transfer') {
      const dest = ata(to, mint, program);
      const exists = await rpc('getAccountInfo(destination)', () => conn.getAccountInfo(dest, 'confirmed'));
      if (!exists) ixs.push(new TransactionInstruction({ programId: new PublicKey(PROGRAMS.ATA), data: Buffer.from([1]), keys: [
        { pubkey: from, isSigner: true, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: program, isSigner: false, isWritable: false }] }));
      ixs.push(new TransactionInstruction({ programId: program, data: Buffer.concat([Buffer.from([12]), u64le(raw), Buffer.from([m.decimals])]), keys: [
        { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: from, isSigner: true, isWritable: false }] }));
      Object.assign(summary, { to: b.to, mint: b.mint, sourceAccount: source.toBase58(), destinationAccount: dest.toBase58(), createsDestination: !exists });
    } else {
      ixs.push(new TransactionInstruction({ programId: program, data: Buffer.concat([Buffer.from([13]), u64le(raw), Buffer.from([m.decimals])]), keys: [
        { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: to, isSigner: false, isWritable: false }, { pubkey: from, isSigner: true, isWritable: false }] }));
      Object.assign(summary, { delegate: b.to, mint: b.mint, sourceAccount: source.toBase58(), unlimited: raw === U64_MAX });
    }
    Object.assign(summary, { amountRaw: raw.toString(), amount: raw === U64_MAX ? 'unlimited (u64 max)' : units(raw, m.decimals), decimals: m.decimals, price });
  }

  if (b.type === 'program_call') {
    if (!b.programId) throw bad('PROGRAM_REQUIRED', 'Give the program id.');
    const data = Buffer.from((b.data ?? '').replace(/^0x/, ''), 'hex');
    ixs.push(new TransactionInstruction({ programId: new PublicKey(b.programId), data, keys: b.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })) }));
    Object.assign(summary, { programId: b.programId, dataBytes: data.length, accounts: b.accounts.length });
  }

  if (b.memo) ixs.push(new TransactionInstruction({ programId: new PublicKey(PROGRAMS.MEMO), data: Buffer.from(b.memo, 'utf8'), keys: [{ pubkey: from, isSigner: true, isWritable: false }] }));

  const { blockhash } = await rpc('getLatestBlockhash', () => conn.getLatestBlockhash('confirmed'));
  const msg = new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const transaction = Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
  if (transaction.length > 2000) throw new HttpError(422, 'TX_TOO_LARGE', 'The transaction is too large for one evaluation request.');
  return { transaction, summary, signed: false };
}

// ------------------------------------------------------------------------------ executor

type Auth = 'session' | 'key' | 'none';
interface Route { id: string; method: 'GET' | 'POST'; re: RegExp; auth: Auth; record?: boolean }
const ID = '[A-Za-z0-9_]{1,40}';
const ORG = (rest: string) => new RegExp(`^/v1/orgs/(${ID})${rest}$`);
export const ROUTES: Route[] = [
  { id: 'agent.evaluate', method: 'POST', re: /^\/v1\/transactions\/evaluate$/, auth: 'key' },
  { id: 'agent.execution_request', method: 'POST', re: /^\/v1\/execution\/requests$/, auth: 'key' },
  { id: 'agent.transactions', method: 'GET', re: /^\/v1\/transactions$/, auth: 'key' },
  { id: 'agent.transaction', method: 'GET', re: new RegExp(`^/v1/transactions/${ID}$`), auth: 'key' },
  { id: 'agent.self', method: 'GET', re: /^\/v1\/agent$/, auth: 'key' },
  { id: 'public.keys', method: 'GET', re: /^\/v1\/\.well-known\/intercept-keys$/, auth: 'none' },
  { id: 'public.feed', method: 'GET', re: /^\/v1\/public\/feed$/, auth: 'none' },
  { id: 'public.stats', method: 'GET', re: /^\/v1\/public\/stats$/, auth: 'none' },
  { id: 'policy.validate', method: 'POST', re: /^\/v1\/policies\/validate$/, auth: 'session' },
  { id: 'policy.default', method: 'GET', re: /^\/v1\/policy-schema\/default$/, auth: 'none' },
  { id: 'org.agents', method: 'GET', re: ORG('/agents'), auth: 'session' },
  { id: 'org.agent', method: 'GET', re: ORG(`/agents/${ID}`), auth: 'session' },
  { id: 'org.evaluations', method: 'GET', re: ORG('/evaluations'), auth: 'session' },
  { id: 'org.evaluation', method: 'GET', re: ORG(`/evaluations/${ID}`), auth: 'session' },
  { id: 'org.policies', method: 'GET', re: ORG('/policies'), auth: 'session' },
  { id: 'org.policy', method: 'GET', re: ORG(`/policies/${ID}`), auth: 'session' },
  { id: 'org.alerts', method: 'GET', re: ORG('/alerts'), auth: 'session' },
  { id: 'org.metrics', method: 'GET', re: ORG('/metrics'), auth: 'session' },
  { id: 'org.wallets', method: 'GET', re: ORG('/wallets'), auth: 'session' },
  { id: 'org.wallet_events', method: 'GET', re: ORG(`/wallets/${ID}/events`), auth: 'session' },
  { id: 'playground.evaluate', method: 'POST', re: ORG('/playground/evaluate'), auth: 'session' },
  { id: 'playground.build', method: 'POST', re: ORG('/playground/build'), auth: 'session', record: false },
];

export const requestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: z.string().min(3).max(200),
  query: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/), z.string().max(200)).default({}),
  headers: z.record(z.string().max(200)).default({}),
  body: z.unknown().optional(),
  apiKey: z.string().regex(/^[\x21-\x7e]{1,200}$/).optional(),
  scenario: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
}).strict();
export type ExecInput = z.infer<typeof requestSchema>;

const RESERVED = /^(x-icpt-|x-forwarded-|x-real-ip|x-vercel-)/i;
const KEEP_HEADERS = ['content-type', 'x-request-id', 'cache-control', 'content-length'];
const TIMEOUT_MS = Number(process.env.PLAYGROUND_TIMEOUT_MS ?? 25_000);

export async function execute(app: FastifyInstance, db: Db, req: FastifyRequest, who: { orgId: string; userId: string }, x: ExecInput) {
  const path = x.path.split('?')[0];
  if (!/^\/v1\/[A-Za-z0-9_\-./]*$/.test(path) || path.includes('..') || path.includes('//')) throw bad('PLAYGROUND_INVALID_PATH', 'The path must be an Intercept API path such as /v1/transactions/evaluate.');
  const byPath = ROUTES.filter((r) => r.re.test(path));
  if (!byPath.length) throw new HttpError(403, 'PLAYGROUND_ENDPOINT_NOT_ALLOWED', `${path} is not available in the Playground. Allowed: agent transaction routes, read-only organization routes, and the playground sandbox.`);
  const route = byPath.find((r) => r.method === x.method);
  if (!route) throw new HttpError(405, 'PLAYGROUND_METHOD_NOT_ALLOWED', `${x.method} ${path} is not available in the Playground; use ${byPath.map((r) => r.method).join(' or ')}.`);
  const orgInPath = path.match(/^\/v1\/orgs\/([^/]+)/)?.[1];
  if (orgInPath && orgInPath !== who.orgId) throw new HttpError(403, 'PLAYGROUND_OTHER_ORG', 'The Playground only calls routes of the selected organization.');

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(x.headers)) {
    const n = k.toLowerCase();
    if (!/^x-[a-z0-9-]{1,40}$/.test(n) || RESERVED.test(n)) throw bad('PLAYGROUND_HEADER_NOT_ALLOWED', `Header ${k} cannot be set here; custom headers must start with x- (credentials are configured in Authentication).`);
    headers[n] = v;
  }
  if (Object.keys(headers).length > 10) throw bad('PLAYGROUND_TOO_MANY_HEADERS', 'At most 10 custom headers.');
  let auth = route.auth === 'session' ? 'session' : 'none';
  if (route.auth === 'session') { headers.cookie = String(req.headers.cookie ?? ''); headers.origin = String(req.headers.origin ?? ''); }
  if (route.auth === 'key' && x.apiKey) {
    // a key from another organization is refused before it is used
    const k = await one(db, 'SELECT org_id, prefix FROM api_keys WHERE prefix = $1', [x.apiKey.slice(0, 18)]);
    if (k && k.org_id !== who.orgId) throw new HttpError(403, 'PLAYGROUND_OTHER_ORG', 'This API key belongs to another organization.');
    headers.authorization = `Bearer ${x.apiKey}`;
    auth = `api_key ${x.apiKey.slice(0, 18)}…`;
  } else if (route.auth === 'key') auth = 'api_key (none)';
  headers[MARK] = NONCE;
  const payload = x.method === 'GET' ? undefined : x.body ?? {};
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const qs = new URLSearchParams(x.query).toString();
  const url = path + (qs ? `?${qs}` : '');

  const t0 = performance.now();
  let res: any;
  let timer: NodeJS.Timeout | undefined;
  try {
    res = await Promise.race([
      app.inject({ method: x.method, url, headers, payload: payload as any, remoteAddress: req.ip }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new HttpError(504, 'PLAYGROUND_TIMEOUT', `The request took longer than ${TIMEOUT_MS / 1000} s and was abandoned.`)), TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
  const durationMs = Math.round(performance.now() - t0);
  let body: unknown = res.body;
  try { body = JSON.parse(res.body); } catch { /* not JSON */ }
  const outHeaders = Object.fromEntries(KEEP_HEADERS.filter((h) => res.headers[h] !== undefined).map((h) => [h, String(res.headers[h])]));
  const b: any = body && typeof body === 'object' ? body : {};
  const decision = typeof b.decision === 'string' && ['ALLOW', 'DENY', 'REQUIRE_APPROVAL'].includes(b.decision) ? b.decision : null;
  const out = { status: res.statusCode as number, durationMs, sizeBytes: Buffer.byteLength(res.body ?? ''), requestId: outHeaders['x-request-id'] ?? null, headers: outHeaders, body, sandboxed: route.id === 'agent.evaluate' || route.id === 'agent.execution_request' || route.id === 'playground.evaluate', endpoint: route.id, historyId: null as string | null };

  if (route.record !== false) {
    const id = newId('pgr');
    const reqBody = payload && typeof payload === 'object' ? payload : null;
    const cap = (v: unknown, n: number) => { const s = JSON.stringify(v ?? null); return s.length <= n ? v : { truncated: true, bytes: s.length }; };
    await q(db, `INSERT INTO playground_requests(id, org_id, user_id, method, path, endpoint, status, decision, duration_ms, agent_id, environment, scenario, auth, request, response)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, who.orgId, who.userId, x.method, url, route.id, out.status, decision, durationMs, typeof b.agentId === 'string' ? b.agentId : (reqBody as any)?.agentId ?? x.query.agentId ?? null,
        typeof b.network === 'string' ? b.network : null, x.scenario ?? null, auth,
        JSON.stringify({ query: x.query, headers: x.headers, body: cap(reqBody, 16_000) }),
        JSON.stringify({ status: out.status, headers: outHeaders, durationMs, sizeBytes: out.sizeBytes, requestId: out.requestId, sandboxed: out.sandboxed, body: cap(body, 96_000) })]);
    out.historyId = id;
    if (Math.random() < 0.1) await q(db, `DELETE FROM playground_requests WHERE id IN (SELECT id FROM playground_requests WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC OFFSET 200)`, [who.orgId, who.userId]);
  }
  return out;
}

// ------------------------------------------------------------------------------ history

const FILTERS: Record<string, string> = {
  success: 'status < 400', failed: 'status >= 400',
  ALLOW: `decision = 'ALLOW'`, DENY: `decision = 'DENY'`, REQUIRE_APPROVAL: `decision = 'REQUIRE_APPROVAL'`,
};
export async function history(db: Db, orgId: string, userId: string, filter: string | null, limit: number) {
  const where = filter && FILTERS[filter] ? ` AND ${FILTERS[filter]}` : '';
  const rows = await q(db, `SELECT id, method, path, endpoint, status, decision, duration_ms, agent_id, environment, scenario, auth, created_at
    FROM playground_requests WHERE org_id = $1 AND user_id = $2${where} ORDER BY created_at DESC LIMIT $3`, [orgId, userId, limit]);
  return rows.map((r) => ({ id: r.id, method: r.method, path: r.path, endpoint: r.endpoint, status: r.status, decision: r.decision, durationMs: r.duration_ms, agentId: r.agent_id, environment: r.environment, scenario: r.scenario, auth: r.auth, createdAt: r.created_at }));
}
export async function historyItem(db: Db, orgId: string, userId: string, id: string) {
  const r = await one(db, 'SELECT * FROM playground_requests WHERE id = $1 AND org_id = $2 AND user_id = $3', [id, orgId, userId]);
  if (!r) throw notFound('Playground request');
  return { id: r.id, method: r.method, path: r.path, endpoint: r.endpoint, status: r.status, decision: r.decision, durationMs: r.duration_ms, agentId: r.agent_id, environment: r.environment, scenario: r.scenario, auth: r.auth, createdAt: r.created_at, request: r.request, response: r.response };
}
