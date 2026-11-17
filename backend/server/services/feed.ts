/**
 * Public live feed.
 *  - mainnet_scan: recent real mainnet transactions (Jupiter swaps, token transfers), re-evaluated by
 *    the full engine (decode, simulate at the current slot, price) against the reference policy.
 *    Fee payer = acting wallet. The original signature links to the explorer.
 *  - customer: decisions of organizations that opted in (organizations.public_feed), anonymized:
 *    no organization, agent, wallet, key or exact amount.
 */
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Db, one, q } from '../db';
import { decStr, newId } from '../lib/util';
import { policyConfigSchema } from '../policy/schema';
import { buildContext } from '../engine/context';
import { decide, firewallChecks, riskChecks, systemChecks } from '../engine/checks';
import { PROGRAMS, PROGRAM_NAMES } from '../solana/programs';
import { connection, rpc } from '../solana/rpc';
import { decodeInner } from '../solana/decode';
import type { Simulation } from '../solana/simulate';

const SCAN_EVERY_MS = Number(process.env.FEED_SCAN_EVERY_MS ?? 20_000);
const PER_SCAN = Number(process.env.FEED_PER_SCAN ?? 3);
const SOURCES = [PROGRAMS.JUPITER_V6, PROGRAMS.TOKEN];
const KEEP = 500;

/** Reference policy of the public scan: a typical trading-bot setup, published on the page. */
export const FEED_POLICY = policyConfigSchema.parse({
  risk: { maxTransactionValueUsd: '5000', maxDailySpendUsd: null, maxSlippageBps: 300 },
  security: { blockUnknownRecipients: false, unknownInstructions: 'REQUIRE_APPROVAL', requireSimulation: true },
  execution: { requireApprovalAboveUsd: '1000', failClosed: true, unsupportedChecks: 'WARN' },
});

export function bucket(v: string | null): string | null {
  if (v === null) return null;
  const n = Number(v);
  if (n < 10) return '<$10';
  if (n < 100) return '$10–100';
  if (n < 1_000) return '$100–1k';
  if (n < 10_000) return '$1k–10k';
  if (n < 100_000) return '$10k–100k';
  return '>$100k';
}

const kindsOf = (instructions: any[]) => [...new Set(instructions.flatMap((i) => (i.effects ?? []).map((e: any) => e.kind)).filter((k: string) => !['COMPUTE_BUDGET', 'MEMO', 'NOOP'].includes(k)))].slice(0, 6);
const programLabels = (programs: string[]) => programs.filter((p) => p !== PROGRAMS.COMPUTE_BUDGET).map((p) => PROGRAM_NAMES[p] ?? 'Unknown program').slice(0, 5);

/** Called after every evaluation; no-op unless the organization opted in. */
export async function recordCustomer(db: Db, orgId: string, e: { decision: string; reasons: { code: string }[]; valueUsd: string | null; network: string; programs: string[]; instructions: any[]; simStatus: string | null; latencyMs: number }) {
  const org = await one(db, 'SELECT public_feed FROM organizations WHERE id = $1', [orgId]);
  if (!org?.public_feed) return;
  await q(db, `INSERT INTO public_feed(id, source, network, decision, reasons, value_usd, value_bucket, programs, kinds, sim_status, latency_ms)
    VALUES ($1,'customer',$2,$3,$4,NULL,$5,$6,$7,$8,$9)`,
    [newId('fd'), e.network, e.decision, e.reasons.map((r) => r.code).slice(0, 4), bucket(e.valueUsd), programLabels(e.programs), kindsOf(e.instructions), e.simStatus, e.latencyMs]);
}

/** Evaluates a few fresh mainnet transactions if the last scan is older than SCAN_EVERY_MS. */
export async function refreshScan(db: Db, conn: Connection = connection('mainnet-beta')): Promise<number> {
  // one scanner at a time across instances; skip if the feed is fresh
  const claim = await one(db, `INSERT INTO kv_state(key, value, updated_at) VALUES ('feed_scan', '', now())
    ON CONFLICT (key) DO UPDATE SET updated_at = now() WHERE kv_state.updated_at < now() - ($1 || ' milliseconds')::interval RETURNING key`, [String(SCAN_EVERY_MS)]);
  if (!claim) return 0;
  const cursor = await one(db, `SELECT value FROM kv_state WHERE key = 'feed_source'`);
  const i = (Number(cursor?.value ?? 0) + 1) % SOURCES.length;
  await q(db, `INSERT INTO kv_state(key, value) VALUES ('feed_source', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [String(i)]);

  const sigs = await rpc('getSignaturesForAddress', () => conn.getSignaturesForAddress(new PublicKey(SOURCES[i]), { limit: 25 }, 'confirmed'));
  const fresh = sigs.filter((s) => !s.err);
  const known = new Set((await q(db, 'SELECT signature FROM public_feed WHERE signature = ANY($1)', [fresh.map((s) => s.signature)])).map((r) => r.signature));
  let done = 0;
  for (const s of fresh) {
    if (done >= PER_SCAN) break;
    if (known.has(s.signature)) continue;
    try {
      const t = await rpc('getTransaction', () => conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
      if (!t) continue;
      const vtx = new VersionedTransaction(t.transaction.message as any);
      const t0 = Date.now();
      const meta = t.meta!;
      // the recorded execution, in the same shape as a simulation result
      const observed = (decoded: any): Simulation => {
        const keys: string[] = decoded.accountKeys;
        const solChanges = keys.map((account, k) => ({ account, pre: String(meta.preBalances[k] ?? 0), post: String(meta.postBalances[k] ?? 0), delta: String((meta.postBalances[k] ?? 0) - (meta.preBalances[k] ?? 0)) })).filter((c) => c.delta !== '0');
        const tokenOwners: Record<string, { owner: string; mint: string }> = {};
        const tok = new Map<number, { pre: bigint; post: bigint; mint: string; owner: string; program: string }>();
        for (const [list, field] of [[meta.preTokenBalances ?? [], 'pre'], [meta.postTokenBalances ?? [], 'post']] as const) {
          for (const b of list) {
            const e = tok.get(b.accountIndex) ?? { pre: 0n, post: 0n, mint: b.mint, owner: b.owner ?? '', program: b.programId ?? '' };
            e[field] = BigInt(b.uiTokenAmount.amount);
            tok.set(b.accountIndex, e);
            if (b.owner) tokenOwners[keys[b.accountIndex]] = { owner: b.owner, mint: b.mint };
          }
        }
        const tokenChanges = [...tok].filter(([, e]) => e.pre !== e.post).map(([k, e]) => ({ account: keys[k], mint: e.mint, owner: e.owner, program: e.program, pre: e.pre.toString(), post: e.post.toString(), delta: (e.post - e.pre).toString(), created: false, closed: false }));
        return { status: 'SUCCESS', reason: 'recorded execution', slot: t.slot, error: null, logs: (meta.logMessages ?? []).slice(0, 80), unitsConsumed: meta.computeUnitsConsumed ?? null,
          innerInstructions: decodeInner(meta.innerInstructions as any, keys), solChanges, tokenChanges, tokenOwners, trackedAccounts: keys.length, replacedBlockhash: false };
      };
      const ctx = await buildContext(vtx, { conn, network: 'mainnet-beta', wallet: null, runSimulation: false, observed });
      const checks = [
        ...systemChecks({ status: 'ACTIVE', mode: 'EVALUATION', walletVerified: false, orgEmergencyStop: false }),
        ...firewallChecks(ctx, FEED_POLICY),
        ...riskChecks(ctx, FEED_POLICY, { dailySpendUsd: 0n, protocolSpendUsd: {} }),
      ].filter((c) => c.code !== 'SEC_WALLET_NOT_SIGNER'); // no agent wallet: the fee payer is analyzed
      const { decision, reasons } = decide(checks);
      await q(db, `INSERT INTO public_feed(id, source, network, decision, reasons, value_usd, value_bucket, programs, kinds, sim_status, latency_ms, signature)
        VALUES ($1,'mainnet_scan','mainnet-beta',$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [newId('fd'), decision, reasons.map((r) => r.code).slice(0, 4), ctx.valueUsd === null ? null : decStr(ctx.valueUsd, 2), bucket(ctx.valueUsd === null ? null : decStr(ctx.valueUsd, 2)),
          programLabels(ctx.decoded.programs), kindsOf(ctx.allInstructions), ctx.simulation?.status ?? null, Date.now() - t0, s.signature]);
      done++;
    } catch { /* RPC hiccup: try the next signature */ }
  }
  if (Math.random() < 0.1) await q(db, `DELETE FROM public_feed WHERE id IN (SELECT id FROM public_feed ORDER BY created_at DESC OFFSET ${KEEP})`);
  return done;
}

export async function feed(db: Db, limit: number, since: string | null) {
  const rows = await q(db, `SELECT * FROM public_feed ${since ? 'WHERE created_at > $2' : ''} ORDER BY created_at DESC LIMIT $1`, since ? [limit, since] : [limit]);
  return rows.map((r) => ({
    id: r.id, at: r.created_at, source: r.source, network: r.network, decision: r.decision, reasons: r.reasons,
    valueUsd: r.value_usd, valueBucket: r.value_bucket, programs: r.programs, kinds: r.kinds, simulation: r.sim_status, latencyMs: r.latency_ms,
    signature: r.signature, explorer: r.signature ? `https://solscan.io/tx/${r.signature}` : null,
  }));
}

export async function stats(db: Db) {
  const r = await one(db, `SELECT count(*)::int total,
      count(*) FILTER (WHERE decision = 'ALLOW')::int allow, count(*) FILTER (WHERE decision = 'DENY')::int deny,
      count(*) FILTER (WHERE decision = 'REQUIRE_APPROVAL')::int approval,
      COALESCE(sum(value_usd), 0)::text value, percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) p50
    FROM public_feed WHERE created_at > now() - interval '24 hours'`);
  const top = await q(db, `SELECT code, count(*)::int n FROM public_feed, unnest(reasons) code WHERE created_at > now() - interval '24 hours' GROUP BY code ORDER BY n DESC LIMIT 6`);
  return { policy: FEED_POLICY, windowHours: 24, evaluations: r.total, decisions: { ALLOW: r.allow, DENY: r.deny, REQUIRE_APPROVAL: r.approval }, valueEvaluatedUsd: r.value, latencyP50Ms: r.p50, topReasons: top };
}
