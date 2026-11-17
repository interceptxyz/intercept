import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { Keypair, PublicKey } from '@solana/web3.js';
import { buildApp } from '../server/http/app';
import { closePool, getPool } from '../server/db';
import { setConnection } from '../server/solana/rpc';
import { setFetcher } from '../server/market/prices';
import { setPoster } from '../server/services/webhooks';
import { PROGRAMS } from '../server/solana/programs';
import { FakeChain, WSOL_MINT, priceFetcher } from './fake-chain';

let app: any;
const chain = new FakeChain();
const wallet = Keypair.generate().publicKey;
const friend = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const SOL = 1_000_000_000;
const verifier = async (t: string) => { const [, did, email] = t.replace(/_+$/, '').split('|'); return { did, email, wallet: null }; };
async function login(did: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/privy', headers: { origin: 'https://app.test' }, payload: { token: `user|${did}|${email}`.padEnd(30, '_') } });
  return String(r.headers['set-cookie']).split(';')[0];
}
const as = (cookie: string) => (method: string, url: string, payload?: unknown) => app.inject({ method, url, payload, headers: { cookie, origin: 'https://app.test' } });
const count = async (t: string) => Number((await getPool().query(`SELECT count(*) n FROM ${t}`)).rows[0].n);
const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(PROGRAMS.TOKEN).toBuffer(), mint.toBuffer()], new PublicKey(PROGRAMS.ATA))[0];

beforeAll(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL!.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS intercept_test WITH (FORCE)');
  await admin.query('CREATE DATABASE intercept_test');
  await admin.end();
  chain.wallet(wallet.toBase58(), 100 * SOL);
  chain.mint(mint.toBase58(), 6);
  chain.token(ata(wallet).toBase58(), mint.toBase58(), wallet.toBase58(), 5_000_000_000n);
  setConnection('devnet', chain.connection());
  setFetcher(priceFetcher(chain, { [WSOL_MINT]: { usd: 100 } }));
  setPoster(async () => ({ status: 200 }));
  app = await buildApp({ verifier, logger: false });
});
afterAll(async () => { await app?.close(); await closePool(); });

describe('API Playground', () => {
  let alice: ReturnType<typeof as>, bob: ReturnType<typeof as>, orgId = '', bobOrg = '', agentId = '', apiKey = '', bobKey = '';
  const run = (who: any, org: string, x: any) => who('POST', `/v1/orgs/${org}/playground/request`, x);
  const build = async (x: any) => { const r = await alice('POST', `/v1/orgs/${orgId}/playground/build`, { network: 'devnet', from: wallet.toBase58(), ...x }); expect(r.statusCode, r.body).toBe(200); return r.json(); };

  it('sets up two organizations', async () => {
    alice = as(await login('did:a', 'a@x.io')); bob = as(await login('did:b', 'b@x.io'));
    orgId = (await alice('GET', '/v1/auth/session')).json().organizations[0].id;
    bobOrg = (await bob('GET', '/v1/auth/session')).json().organizations[0].id;
    const a = (await alice('POST', `/v1/orgs/${orgId}/agents`, { name: 'Bot', wallet: wallet.toBase58(), network: 'devnet' })).json();
    agentId = a.id;
    apiKey = (await alice('POST', `/v1/orgs/${orgId}/keys`, { agentId, name: 'k', scopes: ['transactions:evaluate', 'transactions:read', 'agent:read'], rateLimitPerMin: 50 })).json().key;
    const b = (await bob('POST', `/v1/orgs/${bobOrg}/agents`, { name: 'Other', wallet: friend.toBase58(), network: 'devnet' })).json();
    bobKey = (await bob('POST', `/v1/orgs/${bobOrg}/keys`, { agentId: b.id, name: 'k', scopes: ['transactions:evaluate'], rateLimitPerMin: 50 })).json().key;
  });

  it('builds unsigned transactions from structured fields, including USD amounts', async () => {
    const t = await build({ type: 'native_transfer', to: friend.toBase58(), amountUsd: '250' });
    expect(t.signed).toBe(false);
    expect(t.summary.amount).toBe('2.5'); // 250 USD at 100 USD
    const u = await build({ type: 'token_approve', to: friend.toBase58(), mint: mint.toBase58(), unlimited: true });
    expect(u.summary.unlimited).toBe(true);
    const bad = await alice('POST', `/v1/orgs/${orgId}/playground/build`, { network: 'devnet', type: 'native_transfer', from: wallet.toBase58(), to: friend.toBase58() });
    expect(bad.json().error.code).toBe('AMOUNT_REQUIRED');
  });

  it('runs the real engine in a sandbox with isolated test policies', async () => {
    const before = { e: await count('evaluations'), a: await count('alerts'), z: await count('authorizations') };
    const tx = (await build({ type: 'native_transfer', to: friend.toBase58(), amount: '5' })).transaction; // 500 USD
    chain.setPost(wallet.toBase58(), { lamports: 95 * SOL, owner: PROGRAMS.SYSTEM, data: Buffer.alloc(0) });
    chain.setPost(friend.toBase58(), { lamports: 5 * SOL, owner: PROGRAMS.SYSTEM, data: Buffer.alloc(0) });
    const policy = (x: any) => ({ risk: { maxTransactionValueUsd: '1000', ...x.risk }, security: { blockUnknownRecipients: false }, execution: { ...x.execution } });
    const ev = async (body: any, scenario?: string) => { const r = await run(alice, orgId, { method: 'POST', path: `/v1/orgs/${orgId}/playground/evaluate`, body: { network: 'devnet', wallet: wallet.toBase58(), transaction: tx, ...body }, scenario }); expect(r.statusCode, r.body).toBe(200); return r.json(); };
    // the engine computes the decision; nothing here is hardcoded
    const s = { a: await ev({ policy: policy({}) }, 'authorized'),
      d: await ev({ policy: policy({ execution: { requireApprovalAboveUsd: '100' } }) }, 'approval'),
      f: await ev({ policy: policy({ risk: { maxDailySpendUsd: '1000' } }), assume: { dailySpendUsd: '800' } }, 'daily'),
      c: await ev({ policy: policy({ risk: { maxTransactionValueUsd: '100' } }) }) };
    expect(s.a.body).toMatchObject({ sandbox: true, decision: 'ALLOW', valueUsd: '500', authorization: null, policy: { source: 'custom' } });
    expect(s.a.sandboxed).toBe(true);
    expect(s.d.body.decision).toBe('REQUIRE_APPROVAL');
    expect(s.f.body.decision).toBe('DENY');
    expect(s.f.body.reasons[0].code).toBe('RISK_DAILY_SPEND');
    expect(s.f.body.history).toEqual({ source: 'assumed', dailySpendUsd: '800' });
    expect(s.c.body.reasons[0].code).toBe('RISK_MAX_TX_VALUE');
    chain.post.clear();
    const approve = (await build({ type: 'token_approve', to: friend.toBase58(), mint: mint.toBase58(), unlimited: true })).transaction;
    const e = await ev({ transaction: approve, policy: policy({}) });
    expect(e.body.decision).toBe('DENY');
    expect(e.body.reasons.map((r: any) => r.code)).toContain('SEC_DELEGATE_APPROVAL');
    // production state untouched: no evaluation, alert or authorization, no approval queue
    expect({ e: await count('evaluations'), a: await count('alerts'), z: await count('authorizations') }).toEqual(before);
    const m = (await alice('GET', `/v1/orgs/${orgId}/metrics`)).json();
    expect(m.decisions).toEqual({});
    expect(m.pendingApprovals).toBe(0);
  });

  it('replays agent routes with the real key auth, but sandboxed', async () => {
    const tx = (await build({ type: 'native_transfer', to: friend.toBase58(), amount: '1' })).transaction;
    const r = (await run(alice, orgId, { method: 'POST', path: '/v1/transactions/evaluate', apiKey, body: { transaction: tx } })).json();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sandbox: true, via: 'api_key', agentId, policy: { source: 'agent', version: 1 } });
    expect(r.requestId).toMatch(/^req_/);
    expect(await count('evaluations')).toBe(0);
    const noKey = (await run(alice, orgId, { method: 'POST', path: '/v1/transactions/evaluate', body: { transaction: tx } })).json();
    expect(noKey.status).toBe(401);
    const wrong = (await run(alice, orgId, { method: 'POST', path: '/v1/transactions/evaluate', apiKey: 'icpt_test_' + 'x'.repeat(48), body: { transaction: tx } })).json();
    expect(wrong.status).toBe(401);
    const self = (await run(alice, orgId, { method: 'GET', path: '/v1/agent', apiKey })).json();
    expect(self.body.id).toBe(agentId);
    // a forged playground header from outside is ignored: that request is a real, recorded evaluation
    const forged = await app.inject({ method: 'POST', url: '/v1/transactions/evaluate', headers: { authorization: `Bearer ${apiKey}`, 'x-icpt-playground': 'f'.repeat(48) }, payload: { transaction: tx } });
    expect(forged.json().sandbox).toBeUndefined();
    expect(await count('evaluations')).toBe(1);
  });

  it('only calls allowlisted routes of the selected organization', async () => {
    const del = await run(alice, orgId, { method: 'DELETE', path: `/v1/orgs/${orgId}/agents/${agentId}` });
    expect(del.json().error.code).toBe('PLAYGROUND_METHOD_NOT_ALLOWED');
    const keys = await run(alice, orgId, { method: 'GET', path: `/v1/orgs/${orgId}/keys` });
    expect(keys.json().error.code).toBe('PLAYGROUND_ENDPOINT_NOT_ALLOWED');
    const other = await run(alice, orgId, { method: 'GET', path: `/v1/orgs/${bobOrg}/agents` });
    expect(other.json().error.code).toBe('PLAYGROUND_OTHER_ORG');
    const foreignKey = await run(alice, orgId, { method: 'GET', path: '/v1/agent', apiKey: bobKey });
    expect(foreignKey.json().error.code).toBe('PLAYGROUND_OTHER_ORG');
    const trav = await run(alice, orgId, { method: 'GET', path: '/v1/../internal/tick' });
    expect(trav.statusCode).toBe(400);
    const hdr = await run(alice, orgId, { method: 'GET', path: '/v1/public/stats', headers: { authorization: 'x' } });
    expect(hdr.json().error.code).toBe('PLAYGROUND_HEADER_NOT_ALLOWED');
    // bob cannot use alice's organization at all
    expect((await run(bob, orgId, { method: 'GET', path: '/v1/public/stats' })).statusCode).toBe(404);
    const list = (await run(alice, orgId, { method: 'GET', path: `/v1/orgs/${orgId}/agents` })).json();
    expect(list.status).toBe(200);
    expect(list.body[0].id).toBe(agentId);
  });

  it('keeps a redacted history per organization and user', async () => {
    const h = (await alice('GET', `/v1/orgs/${orgId}/playground/history`)).json().items;
    expect(h.length).toBeGreaterThan(5);
    expect(h.some((x: any) => x.endpoint === 'playground.build')).toBe(false);
    const withKey = h.find((x: any) => x.auth.startsWith('api_key icpt_test_') );
    expect(withKey.auth).toMatch(/^api_key icpt_test_.{8}…$/);
    const item = (await alice('GET', `/v1/orgs/${orgId}/playground/history/${withKey.id}`)).json();
    expect(JSON.stringify(item)).not.toContain(apiKey);
    expect(item.response.status).toBe(200);
    const denied = (await alice('GET', `/v1/orgs/${orgId}/playground/history?filter=DENY`)).json().items;
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every((x: any) => x.decision === 'DENY')).toBe(true);
    expect(h.find((x: any) => x.scenario === 'daily')).toBeTruthy();
    expect((await bob('GET', `/v1/orgs/${bobOrg}/playground/history`)).json().items).toEqual([]);
    expect((await bob('GET', `/v1/orgs/${bobOrg}/playground/history/${withKey.id}`)).statusCode).toBe(404);
    const audit = (await alice('GET', `/v1/orgs/${orgId}/audit`)).json();
    expect(audit.some((a: any) => a.action === 'playground.request')).toBe(true);
  });
});
