import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { Keypair, PublicKey } from '@solana/web3.js';
import { sign as edSign, createPrivateKey } from 'crypto';
import bs58 from 'bs58';
import { buildApp } from '../server/http/app';
import { closePool, getPool } from '../server/db';
import { setConnection } from '../server/solana/rpc';
import { setFetcher } from '../server/market/prices';
import { setPoster, signature } from '../server/services/webhooks';
import { verifyAuthorizationToken } from '../server/services/evaluations';
import { config } from '../server/lib/config';
import { FakeChain, WSOL_MINT, ix, priceFetcher, serialize } from './fake-chain';

let app: any;
const chain = new FakeChain();
const wallet = Keypair.generate();
const friend = Keypair.generate().publicKey;
const SOL = 1_000_000_000;
const posts: { url: string; body: string; headers: Record<string, string> }[] = [];

const verifier = async (t: string) => { const [, did, email] = t.replace(/_+$/, '').split('|'); return { did, email, wallet: null }; };

async function login(did: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/privy', headers: { origin: 'https://app.test' }, payload: { token: `user|${did}|${email}`.padEnd(30, '_') } });
  expect(r.statusCode).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}
const as = (cookie: string) => (method: string, url: string, payload?: unknown) => app.inject({ method, url, payload, headers: { cookie, origin: 'https://app.test' } });
const key = (k: string) => (method: string, url: string, payload?: unknown) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${k}` } });

beforeAll(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL!.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS intercept_test WITH (FORCE)');
  await admin.query('CREATE DATABASE intercept_test');
  await admin.end();
  chain.wallet(wallet.publicKey.toBase58(), 10 * SOL);
  setConnection('devnet', chain.connection());
  setFetcher(priceFetcher(chain, { [WSOL_MINT]: { usd: 100 } }));
  setPoster(async (url, body, headers) => { posts.push({ url, body, headers }); return { status: 200 }; });
  app = await buildApp({ verifier, logger: false });
});
afterAll(async () => { await app?.close(); await closePool(); });

describe('Intercept API', () => {
  let alice: ReturnType<typeof as>, bob: ReturnType<typeof as>, orgId: string, agentId: string, apiKey: string, keyId: string, policyId: string;

  it('creates an account and a personal organization on first sign-in', async () => {
    const aliceCookie = await login('did:alice', 'alice@x.io');
    alice = as(aliceCookie);
    const s = (await alice('GET', '/v1/auth/session')).json();
    expect(s.user.email).toBe('alice@x.io');
    expect(s.organizations).toHaveLength(1);
    expect(s.organizations[0].role).toBe('OWNER');
    orgId = s.organizations[0].id;
    // cross-site mutation without the allowed Origin is refused
    const csrf = await app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/agents`, payload: { name: 'x' }, headers: { cookie: aliceCookie, origin: 'https://evil.test' } });
    expect(csrf.json().error.code).toBe('BAD_ORIGIN');
  });

  it('registers an agent with a default versioned policy', async () => {
    const r = await alice('POST', `/v1/orgs/${orgId}/agents`, { name: 'Treasury bot', wallet: wallet.publicKey.toBase58(), network: 'devnet' });
    expect(r.statusCode).toBe(201);
    const a = r.json();
    agentId = a.id; policyId = a.policy.id;
    expect(a).toMatchObject({ status: 'ACTIVE', integrationMode: 'EVALUATION', walletVerified: false, policy: { version: 1 } });
    const bad = await alice('POST', `/v1/orgs/${orgId}/policies/${policyId}/versions`, { config: { risk: { maxTransactionValueUsd: 1000 } } });
    expect(bad.json().error.code).toBe('INVALID_POLICY');
    const v2 = await alice('POST', `/v1/orgs/${orgId}/policies/${policyId}/versions`, { config: { risk: { maxTransactionValueUsd: '1000' }, security: { allowedRecipients: [friend.toBase58()] }, execution: { requireApprovalAboveUsd: '250' } } });
    expect(v2.json()).toMatchObject({ version: 2, agentsUpdated: 1 });
    const p = (await alice('GET', `/v1/orgs/${orgId}/policies/${policyId}`)).json();
    expect(p.versions.map((v: any) => v.version)).toEqual([2, 1]); // immutable history
  });

  it('issues a scoped key once and stores only its digest', async () => {
    const r = await alice('POST', `/v1/orgs/${orgId}/keys`, { agentId, name: 'bot', scopes: ['transactions:evaluate', 'transactions:read', 'agent:read'], rateLimitPerMin: 5 });
    expect(r.statusCode).toBe(201);
    apiKey = r.json().key; keyId = r.json().id;
    expect(apiKey).toMatch(/^icpt_test_[0-9A-Za-z]{48}$/);
    const list = (await alice('GET', `/v1/orgs/${orgId}/keys`)).json();
    expect(JSON.stringify(list)).not.toContain(apiKey.slice(18));
    const row = (await getPool().query('SELECT digest, prefix FROM api_keys WHERE id = $1', [keyId])).rows[0];
    expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(apiKey.startsWith(row.prefix)).toBe(true);
  });

  it('evaluates a real transaction with the agent key', async () => {
    chain.setPost(wallet.publicKey.toBase58(), { lamports: 8 * SOL, owner: '11111111111111111111111111111111', data: Buffer.alloc(0) });
    const tx = serialize(wallet.publicKey, [ix.solTransfer(wallet.publicKey, friend, 2 * SOL)]);
    const r = await key(apiKey)('POST', '/v1/transactions/evaluate', { transaction: tx, reference: 'order-1' });
    expect(r.statusCode).toBe(200);
    const e = r.json();
    expect(e).toMatchObject({ decision: 'ALLOW', valueUsd: '200', policy: { version: 2 }, reference: 'order-1' });
    expect(e.simulation.status).toBe('SUCCESS');
    const big = serialize(wallet.publicKey, [ix.solTransfer(wallet.publicKey, Keypair.generate().publicKey, SOL)]);
    chain.setPost(wallet.publicKey.toBase58(), { lamports: 9 * SOL, owner: '11111111111111111111111111111111', data: Buffer.alloc(0) });
    expect((await key(apiKey)('POST', '/v1/transactions/evaluate', { transaction: big })).json().decision).toBe('DENY');
    expect((await key(apiKey)('GET', '/v1/transactions')).json()).toHaveLength(2);
  });

  it('enforces scopes, rate limits and keeps agents away from admin routes', async () => {
    expect((await key(apiKey)('POST', '/v1/execution/requests', { transaction: 'x'.repeat(100) })).json().error.code).toBe('MISSING_SCOPE');
    expect((await key(apiKey)('GET', `/v1/orgs/${orgId}/agents`)).statusCode).toBe(401); // keys are not sessions
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await key(apiKey)('GET', '/v1/agent')).statusCode);
    expect(codes).toContain(429);
  });

  it('isolates tenants and enforces roles', async () => {
    bob = as(await login('did:bob', 'bob@x.io'));
    expect((await bob('GET', `/v1/orgs/${orgId}/agents`)).statusCode).toBe(404);
    expect((await bob('GET', `/v1/orgs/${orgId}/evaluations`)).statusCode).toBe(404);
    const inv = (await alice('POST', `/v1/orgs/${orgId}/invitations`, { role: 'VIEWER' })).json();
    expect((await bob('POST', '/v1/invitations/accept', { token: inv.token })).json().role).toBe('VIEWER');
    expect((await bob('GET', `/v1/orgs/${orgId}/agents`)).json()).toHaveLength(1);
    expect((await bob('POST', `/v1/orgs/${orgId}/agents/${agentId}/pause`)).statusCode).toBe(403);
    expect((await bob('POST', `/v1/orgs/${orgId}/keys`, { agentId, name: 'x' })).statusCode).toBe(403);
    expect((await bob('POST', '/v1/invitations/accept', { token: inv.token })).statusCode).toBe(400); // single use
  });

  it('requires a verified wallet for enforced execution, then issues single-use authorizations', async () => {
    expect((await alice('PATCH', `/v1/orgs/${orgId}/agents/${agentId}`, { integrationMode: 'ENFORCED_EXECUTION' })).json().error.code).toBe('WALLET_NOT_VERIFIED');
    const ch = (await alice('POST', `/v1/orgs/${orgId}/agents/${agentId}/wallet-challenge`)).json();
    const wrong = bs58.encode(edSign(null, Buffer.from(ch.message), createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Keypair.generate().secretKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' })));
    expect((await alice('POST', `/v1/orgs/${orgId}/agents/${agentId}/wallet-verify`, { challengeId: ch.challengeId, signature: wrong })).json().error.code).toBe('INVALID_SIGNATURE');
    const ch2 = (await alice('POST', `/v1/orgs/${orgId}/agents/${agentId}/wallet-challenge`)).json();
    const sk = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), wallet.secretKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    const good = bs58.encode(edSign(null, Buffer.from(ch2.message), sk));
    expect((await alice('POST', `/v1/orgs/${orgId}/agents/${agentId}/wallet-verify`, { challengeId: ch2.challengeId, signature: good })).json().walletVerified).toBe(true);
    expect((await alice('PATCH', `/v1/orgs/${orgId}/agents/${agentId}`, { integrationMode: 'ENFORCED_EXECUTION' })).json().integrationMode).toBe('ENFORCED_EXECUTION');

    const exe = (await alice('POST', `/v1/orgs/${orgId}/keys`, { agentId, name: 'signer', scopes: ['execution:request', 'transactions:read'], rateLimitPerMin: 50 })).json().key;
    chain.setPost(wallet.publicKey.toBase58(), { lamports: 9 * SOL, owner: '11111111111111111111111111111111', data: Buffer.alloc(0) });
    const tx = serialize(wallet.publicKey, [ix.solTransfer(wallet.publicKey, friend, SOL)]);
    const r = (await key(exe)('POST', '/v1/execution/requests', { transaction: tx })).json();
    expect(r.decision).toBe('ALLOW');
    const claims = verifyAuthorizationToken(r.authorization.token, (await app.inject({ method: 'GET', url: '/v1/.well-known/intercept-keys' })).json().keys[0].publicKey);
    expect(claims).toMatchObject({ agent: agentId, mh: r.messageHash, net: 'devnet' });
    const [tb, ts] = r.authorization.token.split('.');
    const forged = `${tb}.${ts.slice(0, 20)}${ts[20] === 'A' ? 'B' : 'A'}${ts.slice(21)}`;
    expect(verifyAuthorizationToken(forged, config().publicKeyB64)).toBeNull();
    const consume = (mh: string) => key(exe)('POST', `/v1/execution/authorizations/${r.authorization.id}/consume`, { messageHash: mh });
    expect((await consume('0'.repeat(64))).json().error.code).toBe('MESSAGE_MISMATCH');
    expect((await consume(r.messageHash)).json().consumed).toBe(true);
    expect((await consume(r.messageHash)).json().error.code).toBe('ALREADY_CONSUMED');

    // above the approval threshold: pending, approved by an admin, then the agent polls the token
    chain.setPost(wallet.publicKey.toBase58(), { lamports: 7 * SOL, owner: '11111111111111111111111111111111', data: Buffer.alloc(0) });
    const p = (await key(exe)('POST', '/v1/execution/requests', { transaction: serialize(wallet.publicKey, [ix.solTransfer(wallet.publicKey, friend, 3 * SOL)]) })).json();
    expect(p).toMatchObject({ decision: 'REQUIRE_APPROVAL', effectiveDecision: 'PENDING_APPROVAL', authorization: null });
    expect((await bob('POST', `/v1/orgs/${orgId}/evaluations/${p.id}/approve`)).statusCode).toBe(403);
    expect((await alice('POST', `/v1/orgs/${orgId}/evaluations/${p.id}/approve`)).json()).toMatchObject({ status: 'APPROVED', authorizationIssued: true });
    const polled = (await key(exe)('GET', `/v1/execution/requests/${p.id}`)).json();
    expect(polled.effectiveDecision).toBe('ALLOW');
    expect(verifyAuthorizationToken(polled.authorizationToken, config().publicKeyB64)!.mh).toBe(p.messageHash);
  });

  it('delivers signed webhooks and stops everything on emergency stop', async () => {
    const w = (await alice('POST', `/v1/orgs/${orgId}/webhooks`, { url: 'https://example.com/hook', events: ['evaluation.denied', 'organization.emergency_stop'] })).json();
    expect(w.secret).toMatch(/^whsec_/);
    expect((await alice('POST', `/v1/orgs/${orgId}/webhooks`, { url: 'https://127.0.0.1/x', events: ['alert.created'] })).json().error.code).toBe('INVALID_WEBHOOK_URL');
    expect((await alice('POST', `/v1/orgs/${orgId}/emergency-stop`, { active: true })).json().emergencyStop).toBe(true);
    chain.setPost(wallet.publicKey.toBase58(), { lamports: 9 * SOL, owner: '11111111111111111111111111111111', data: Buffer.alloc(0) });
    const e = (await key(apiKey)('POST', '/v1/transactions/evaluate', { transaction: serialize(wallet.publicKey, [ix.solTransfer(wallet.publicKey, friend, SOL)]) }));
    // the default key was rate limited above; use the console evaluation path instead
    const c = (await alice('POST', `/v1/orgs/${orgId}/agents/${agentId}/evaluate`, { transaction: serialize(wallet.publicKey, [ix.solTransfer(wallet.publicKey, friend, SOL)]) })).json();
    expect(c.decision).toBe('DENY');
    expect(c.reasons[0].code).toBe('SYS_EMERGENCY_STOP');
    void e;
    const denied = posts.find((p) => JSON.parse(p.body).type === 'evaluation.denied');
    expect(denied).toBeTruthy();
    const [t] = denied!.headers['intercept-signature'].split(',').map((x) => x.split('=')[1]);
    expect(denied!.headers['intercept-signature']).toBe(signature(w.secret, denied!.body, Number(t)));
    expect((await bob('POST', `/v1/orgs/${orgId}/emergency-stop`, { active: false })).statusCode).toBe(403);
  });

  it('revokes keys immediately and keeps an audit trail', async () => {
    await alice('DELETE', `/v1/orgs/${orgId}/keys/${keyId}`);
    expect((await key(apiKey)('GET', '/v1/agent')).json().error.code).toBe('API_KEY_REVOKED');
    const audit = (await alice('GET', `/v1/orgs/${orgId}/audit`)).json().map((a: any) => a.action);
    for (const a of ['agent.create', 'policy.version', 'api_key.create', 'agent.wallet_verified', 'evaluation.approve', 'emergency_stop.activate', 'api_key.revoke']) expect(audit).toContain(a);
    expect(JSON.stringify(audit)).not.toContain('icpt_');
    const m = (await alice('GET', `/v1/orgs/${orgId}/metrics`)).json();
    expect(m.decisions.ALLOW).toBeGreaterThan(0);
  });
});

void PublicKey;
