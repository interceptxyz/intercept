import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { Keypair, PublicKey } from '@solana/web3.js';
import { buildApp } from '../server/http/app';
import { closePool, getPool } from '../server/db';
import { setConnection } from '../server/solana/rpc';
import { setFetcher } from '../server/market/prices';
import { setPoster, signature } from '../server/services/webhooks';
import { PROGRAMS } from '../server/solana/programs';
import { normalizeValue, NormalizeError } from '../server/network/model';
import { confidence, shouldSuspect } from '../server/network/scoring';
import { canTransition } from '../server/network/lifecycle';
import { independentClusters, REPORT_LIMITS, expireDue, dispatchPending } from '../server/network/service';
import { networkCheck, Intel } from '../server/network/matching';
import { findings } from '../server/network/hooks';
import { policyConfigSchema } from '../server/policy/schema';
import { FakeChain, WSOL_MINT, ix, priceFetcher, serialize } from './fake-chain';

// ------------------------------------------------------------------------------------- unit
describe('network: pure rules', () => {
  it('normalizes addresses per chain family and rejects malformed values', () => {
    expect(normalizeValue('eip155:4663', 'ADDRESS', '0xD893177BFE31E786B3E13734C3D7EABC6F786CB4')).toBe('0xd893177bfe31e786b3e13734c3d7eabc6f786cb4');
    expect(() => normalizeValue('eip155:4663', 'ADDRESS', '0x123')).toThrow(NormalizeError);
    const b58 = Keypair.generate().publicKey.toBase58();
    expect(normalizeValue('devnet', 'ADDRESS', b58)).toBe(b58); // base58 is case-sensitive: kept as is
    expect(() => normalizeValue('devnet', 'ADDRESS', '0xd893177bfe31e786b3e13734c3d7eabc6f786cb4')).toThrow(NormalizeError);
    expect(() => normalizeValue('devnet', 'SELECTOR_CONTEXT', '0x12345678')).toThrow(NormalizeError); // a selector alone is not an indicator
  });
  it('scores evidence, not the number of reports', () => {
    const one = { sourceType: 'USER_REPORT' as const, cluster: 'org:a', verification: 'UNVERIFIED' as const, reliability: 50 };
    const now = new Date();
    const single = confidence([one], [], now).score;
    expect(confidence(Array(20).fill(one), [], now).score).toBe(single); // 20 reports from one source = 1 source
    const two = confidence([one, { ...one, cluster: 'org:b' }], [], now);
    expect(two.score).toBeGreaterThan(single);
    expect(two.factors.map((f) => f.factor)).toContain('independent_corroboration');
    const disputed = confidence([one, { ...one, cluster: 'org:b' }], [{ type: 'dispute', reviewerId: 'r' }], now).score;
    expect(disputed).toBeLessThan(two.score);
    expect(confidence([one], [{ type: 'verify', reviewerId: 'r1' }, { type: 'verify', reviewerId: 'r2' }], now).score).toBeGreaterThan(single + 40);
    expect(shouldSuspect(90, 1)).toBe(false); // one participant can never put an address on the network alone
    expect(shouldSuspect(40, 2)).toBe(true);
  });
  it('treats sources that report the same incident as one', () => {
    const c = independentClusters([{ source: 'org:a', tx: 'T1' }, { source: 'org:b', tx: 'T1' }, { source: 'org:c', tx: null }, { source: 'org:c', tx: 'T2' }]);
    expect(c.get('org:a')).toBe(c.get('org:b'));
    expect(c.get('org:c')).not.toBe(c.get('org:a'));
  });
  it('allows lifecycle transitions both ways but never skips review from REVOKED', () => {
    expect(canTransition('VERIFIED', 'REVOKED')).toBe(true);
    expect(canTransition('REVOKED', 'UNDER_REVIEW')).toBe(true);
    expect(canTransition('REVOKED', 'VERIFIED')).toBe(false);
    expect(canTransition('FALSE_POSITIVE', 'SUSPECTED')).toBe(false);
  });
  it('maps matches to the policy action, never silently', () => {
    const pol = policyConfigSchema.parse({});
    const base: Intel = { status: 'VERIFIED_THREAT', intelligenceVersion: 7, lookupMs: 1, subjectsChecked: 3, cachedLookups: 0, checkedAt: '', error: null, matches: [] };
    const m = { indicatorId: 'ind_1', value: 'X', matchedField: 'delegate', indicatorType: 'ADDRESS', category: 'WALLET_DRAINER', severity: 'CRITICAL' as const, confidence: 90, status: 'VERIFIED', evidenceSummary: '', intelligenceVersion: 7, explanation: 'x' };
    expect(networkCheck({ ...base, matches: [{ ...m, policyAction: 'BLOCK' }] }, pol)).toMatchObject({ effect: 'DENY', status: 'FAILED', severity: 'CRITICAL' });
    expect(networkCheck({ ...base, matches: [{ ...m, policyAction: 'WARN' }] }, pol)).toMatchObject({ effect: 'NONE', status: 'WARNING' });
    const none = networkCheck({ ...base, status: 'NO_KNOWN_MATCH' }, pol);
    expect(none.status).toBe('PASSED');
    expect(none.reason).toMatch(/does not mean the transaction is safe/);
    const down = networkCheck({ ...base, status: 'INTELLIGENCE_UNAVAILABLE', error: 'timeout' }, policyConfigSchema.parse({ network: { unavailable: 'REQUIRE_APPROVAL' } }));
    expect(down).toMatchObject({ code: 'SEC_NETWORK_UNAVAILABLE', effect: 'REQUIRE_APPROVAL', status: 'UNCERTAIN' });
  });
  it('never turns policy violations into threat observations', () => {
    const ctx: any = { decoded: { unknownPrograms: [] }, allInstructions: [] };
    const checks: any[] = [{ code: 'RISK_MAX_TX_VALUE', status: 'FAILED' }, { code: 'SEC_UNKNOWN_RECIPIENT', status: 'FAILED' }, { code: 'SEC_BLOCKED_RECIPIENT', status: 'FAILED' }];
    expect(findings(checks, ctx)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------- integration
let app: any;
const chain = new FakeChain();
const SOL = 1_000_000_000;
const walletA = Keypair.generate().publicKey, walletB = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const drainer = Keypair.generate().publicKey; // isolated fixture, not a real address
const ata = (o: PublicKey) => PublicKey.findProgramAddressSync([o.toBuffer(), new PublicKey(PROGRAMS.TOKEN).toBuffer(), mint.toBuffer()], new PublicKey(PROGRAMS.ATA))[0];
const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
const verifier = async (t: string) => { const [, did, email] = t.replace(/_+$/, '').split('|'); return { did, email, wallet: null }; };
async function login(did: string, email: string) {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/privy', headers: { origin: 'https://app.test' }, payload: { token: `user|${did}|${email}`.padEnd(30, '_') } });
  return String(r.headers['set-cookie']).split(';')[0];
}
const as = (cookie: string) => (method: string, url: string, payload?: unknown) => app.inject({ method, url, payload, headers: { cookie, origin: 'https://app.test' } });
const withKey = (k: string) => (method: string, url: string, payload?: unknown) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${k}` } });
const n = async (sql: string, p: unknown[] = []) => Number((await getPool().query(sql, p)).rows[0].n);
const approveTx = (owner: PublicKey) => serialize(owner, [ix.approve(ata(owner), drainer, owner, 18446744073709551615n)]);

beforeAll(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL!.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS intercept_test WITH (FORCE)');
  await admin.query('CREATE DATABASE intercept_test');
  await admin.end();
  for (const w of [walletA, walletB]) { chain.wallet(w.toBase58(), 10 * SOL); chain.token(ata(w).toBase58(), mint.toBase58(), w.toBase58(), 1_000_000n); }
  chain.mint(mint.toBase58(), 6);
  setConnection('devnet', chain.connection());
  setFetcher(priceFetcher(chain, { [WSOL_MINT]: { usd: 100 } }));
  setPoster(async (url, body, headers) => { posts.push({ url, body, headers }); return { status: 200 }; });
  app = await buildApp({ verifier, logger: false });
});
afterAll(async () => { await app?.close(); await closePool(); });

describe('Intercept Network', () => {
  let A: any, B: any, C: any, orgA = '', orgB = '', orgC = '', agentA = '', agentB = '', keyB = '', keyNoScope = '', indicatorId = '';
  const R: any = {}; // reviewers
  const NET = (o: string) => `/v1/orgs/${o}/network`;

  it('sets up three organizations, two agents and three reviewers', async () => {
    A = as(await login('did:a', 'a@x.io')); B = as(await login('did:b', 'b@x.io')); C = as(await login('did:c', 'c@x.io'));
    orgA = (await A('GET', '/v1/auth/session')).json().organizations[0].id;
    orgB = (await B('GET', '/v1/auth/session')).json().organizations[0].id;
    orgC = (await C('GET', '/v1/auth/session')).json().organizations[0].id;
    agentA = (await A('POST', `/v1/orgs/${orgA}/agents`, { name: 'Agent A', wallet: walletA.toBase58(), network: 'devnet' })).json().id;
    const b = (await B('POST', `/v1/orgs/${orgB}/agents`, { name: 'Agent B', wallet: walletB.toBase58(), network: 'devnet' })).json();
    agentB = b.id;
    // Agent B's test policy permits delegate approvals: only network intelligence can stop this one
    const v = await B('POST', `/v1/orgs/${orgB}/policies/${b.policy.id}/versions`, { config: { security: { allowDelegateApprovals: true, blockUnknownRecipients: false }, network: { verified: 'BLOCK', suspected: 'WARN' } } });
    expect(v.statusCode, v.body).toBe(201);
    keyB = (await B('POST', `/v1/orgs/${orgB}/keys`, { agentId: agentB, name: 'net', scopes: ['transactions:evaluate', 'network:read', 'network:report'], rateLimitPerMin: 100 })).json().key;
    keyNoScope = (await B('POST', `/v1/orgs/${orgB}/keys`, { agentId: agentB, name: 'plain', scopes: ['transactions:evaluate'], rateLimitPerMin: 100 })).json().key;
    const wh = await B('POST', `/v1/orgs/${orgB}/webhooks`, { url: 'https://example.com/intercept', events: ['threat.verified', 'threat.revoked', 'threat.match.detected'] });
    expect(wh.statusCode, wh.body).toBe(201);
    for (const r of ['r1', 'r2', 'r3']) {
      R[r] = as(await login(`did:${r}`, `${r}@intercept.test`));
      const u = (await R[r]('GET', '/v1/auth/session')).json().user;
      await getPool().query(`INSERT INTO network_reviewers(user_id, role, granted_by) VALUES ($1,'REVIEWER','test')`, [u.id]);
    }
  });

  it('keeps observations private by default', async () => {
    const r = await A('POST', `${NET(orgA)}/reports`, { chain: 'devnet', subject: { type: 'ADDRESS', value: drainer.toBase58() }, category: 'WALLET_DRAINER', description: 'internal note: our treasury bot' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ processingStatus: 'PRIVATE', indicator: null, visibility: 'PRIVATE' });
    expect(await n('SELECT count(*) n FROM threat_indicators')).toBe(0);
  });

  it('1-2. Agent A meets the contract: its firewall finding becomes an observation (sharing enabled)', async () => {
    const s = await A('PATCH', `${NET(orgA)}/subscriptions`, { sharingMode: 'AUTHORIZED_CONTRIBUTION' });
    expect(s.json().sharingMode).toBe('AUTHORIZED_CONTRIBUTION');
    const e = (await A('POST', `/v1/orgs/${orgA}/agents/${agentA}/evaluate`, { transaction: approveTx(walletA) })).json();
    expect(e.decision).toBe('DENY'); // Agent A's own policy forbids delegate approvals
    const o = (await getPool().query(`SELECT * FROM threat_observations WHERE org_id = $1 AND source_type = 'FIREWALL'`, [orgA])).rows;
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ subject_value: drainer.toBase58(), category: 'DANGEROUS_APPROVAL', processing_status: 'ACCEPTED', chain: 'devnet' });
    indicatorId = o[0].indicator_id;
    const ind = (await getPool().query('SELECT * FROM threat_indicators WHERE id = $1', [indicatorId])).rows[0];
    expect(ind.status).toBe('REPORTED'); // one source: never published
    expect((await withKey(keyB)('GET', `/v1/network/indicators/${indicatorId}`)).statusCode).toBe(404);
  });

  it('rejects duplicates, rate-abuse, protected infrastructure and other tenants', async () => {
    const body = { chain: 'devnet', subject: { type: 'ADDRESS', value: Keypair.generate().publicKey.toBase58() }, category: 'PHISHING_ADDRESS' };
    const first = (await withKey(keyB)('POST', '/v1/network/reports', body)).json();
    const again = (await withKey(keyB)('POST', '/v1/network/reports', body)).json();
    expect(again.duplicate).toBe(true);
    expect(await n(`SELECT count(*) n FROM threat_observations WHERE org_id = $1 AND subject_value = $2`, [orgB, body.subject.value])).toBe(1);
    const sys = await withKey(keyB)('POST', '/v1/network/reports', { ...body, subject: { type: 'CONTRACT', value: PROGRAMS.SYSTEM } });
    expect(sys.json().error.code).toBe('PROTECTED_SUBJECT');
    expect((await A('GET', `${NET(orgA)}/reports/${first.id}`)).statusCode).toBe(404); // cross-tenant
    expect((await withKey(keyNoScope)('POST', '/v1/network/reports', body)).json().error.code).toBe('MISSING_SCOPE');
    const old = REPORT_LIMITS.perHour; REPORT_LIMITS.perHour = 1;
    const burst = await withKey(keyB)('POST', '/v1/network/reports', { ...body, subject: { type: 'ADDRESS', value: Keypair.generate().publicKey.toBase58() } });
    REPORT_LIMITS.perHour = old;
    expect(burst.json().error.code).toBe('REPORT_LIMIT');
    const viewer = await C('POST', `${NET(orgA)}/reports`, body);
    expect(viewer.statusCode).toBe(404); // not a member of org A
  });

  it('3. corroboration by an independent source makes it SUSPECTED, never VERIFIED', async () => {
    const r = await R.r1('POST', '/v1/admin/network/observations', { chain: 'devnet', subject: { type: 'ADDRESS', value: drainer.toBase58() }, category: 'DANGEROUS_APPROVAL', description: 'investigation #12' });
    expect(r.statusCode, r.body).toBe(201);
    const ind = (await getPool().query('SELECT * FROM threat_indicators WHERE id = $1', [indicatorId])).rows[0];
    expect(ind.status).toBe('SUSPECTED');
    expect(ind.independent_source_count).toBe(2);
    // shared registry: generated summaries only, no organization, reporter text or raw evidence
    const d = (await withKey(keyB)('GET', `/v1/network/indicators/${indicatorId}`)).json();
    expect(d.status).toBe('SUSPECTED');
    const txt = JSON.stringify(d);
    expect(txt).not.toContain(orgA);
    expect(txt).not.toContain('investigation #12');
    expect(txt).not.toContain('messageHash');
    expect(d.confidenceExplanation.note).toMatch(/not a calibrated probability/);
  });

  it('a suspected match only warns under Agent B\'s policy', async () => {
    const e = (await withKey(keyB)('POST', '/v1/transactions/evaluate', { transaction: approveTx(walletB) })).json();
    expect(e.decision).toBe('ALLOW');
    expect(e.intelligence.status).toBe('SUSPICIOUS');
    expect(e.checks.security.find((c: any) => c.code === 'SEC_NETWORK_THREAT')).toMatchObject({ status: 'WARNING', effect: 'NONE' });
  });

  it('4. verification of a HIGH threat needs two different reviewers, and no reporter', async () => {
    const noRole = await B('POST', `/v1/admin/network/indicators/${indicatorId}/verify`, { reason: 'looks malicious to me' });
    expect(noRole.json().error.code).toBe('NOT_A_REVIEWER');
    const own = await R.r1('POST', `/v1/admin/network/indicators/${indicatorId}/verify`, { reason: 'my own investigation' });
    expect(own.json().error.code).toBe('CONFLICT_OF_INTEREST');
    const first = (await R.r2('POST', `/v1/admin/network/indicators/${indicatorId}/verify`, { reason: 'unlimited allowance to an unknown delegate across agents' })).json();
    expect(first.pendingSecondReview).toBe(true);
    expect(first.indicator.status).toBe('UNDER_REVIEW');
    const same = await R.r2('POST', `/v1/admin/network/indicators/${indicatorId}/verify`, { reason: 'again, same reviewer' });
    expect(same.json().error.code).toBe('SECOND_REVIEWER_REQUIRED');
    const second = (await R.r3('POST', `/v1/admin/network/indicators/${indicatorId}/verify`, { reason: 'confirmed independently', publicSummary: 'Requests unlimited token allowances for an unknown delegate.' })).json();
    expect(second.indicator.status).toBe('VERIFIED');
    expect(second.indicator.confidence).toBeGreaterThanOrEqual(80);
  });

  it('5. publishes the verification through the outbox to subscribed webhooks, signed', async () => {
    await dispatchPending(getPool());
    const p = posts.find((x) => JSON.parse(x.body).type === 'threat.verified');
    expect(p).toBeTruthy();
    const body = JSON.parse(p!.body);
    expect(body.data).toMatchObject({ indicatorId, status: 'VERIFIED', category: 'DANGEROUS_APPROVAL' });
    expect(body.data.intelligenceVersion).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(orgA);
    const secret = (await getPool().query('SELECT secret FROM webhooks WHERE org_id = $1', [orgB])).rows[0].secret;
    const t = Number(p!.headers['intercept-signature'].split(',')[0].split('=')[1]);
    expect(p!.headers['intercept-signature']).toBe(signature(secret, p!.body, t));
    expect(await n('SELECT count(*) n FROM intelligence_events e LEFT JOIN intelligence_dispatch d USING (sequence_number) WHERE d.sequence_number IS NULL')).toBe(0);
  });

  let blockedEval = '';
  it('6-9. Agent B meets the same contract: firewall match, policy BLOCK, organization security event', async () => {
    const e = (await withKey(keyB)('POST', '/v1/transactions/evaluate', { transaction: approveTx(walletB) })).json();
    blockedEval = e.id;
    expect(e.decision).toBe('DENY');
    expect(e.reasons[0].code).toBe('SEC_NETWORK_THREAT');
    expect(e.intelligence).toMatchObject({ status: 'VERIFIED_THREAT' });
    expect(e.intelligence.matches[0]).toMatchObject({ indicatorId, matchedField: 'delegate', policyAction: 'BLOCK', status: 'VERIFIED' });
    expect(await n('SELECT count(*) n FROM threat_matches WHERE evaluation_id = $1', [e.id])).toBe(1);
    const alerts = (await B('GET', `/v1/orgs/${orgB}/alerts`)).json();
    const a = alerts.find((x: any) => x.type === 'NETWORK_VERIFIED_THREAT');
    expect(a.message).toMatch(/flagged \(evaluation mode: not enforced by Intercept\)/); // never "prevented" in evaluation mode
    expect(posts.some((x) => JSON.parse(x.body).type === 'threat.match.detected')).toBe(true);
    // the Playground reads intelligence but records nothing
    const before = await n('SELECT count(*) n FROM threat_matches');
    const sb = (await B('POST', `/v1/orgs/${orgB}/playground/evaluate`, { agentId: agentB, transaction: approveTx(walletB) })).json();
    expect(sb.decision).toBe('DENY');
    expect(await n('SELECT count(*) n FROM threat_matches')).toBe(before);
  });

  it('keeps testnet intelligence away from mainnet and answers batch lookups', async () => {
    const dev = (await withKey(keyB)('POST', '/v1/network/lookup', { chain: 'devnet', addresses: [drainer.toBase58(), walletA.toBase58(), 'not-an-address'] })).json();
    expect(dev).toMatchObject({ status: 'MATCH_FOUND' });
    expect(dev.matches[0]).toMatchObject({ indicatorId, recommendedAction: 'BLOCK' });
    expect(dev.invalid).toHaveLength(1);
    const main = (await withKey(keyB)('POST', '/v1/network/lookup', { chain: 'mainnet-beta', addresses: [drainer.toBase58()] })).json();
    expect(main.status).toBe('NO_KNOWN_MATCH');
    expect(main.note).toMatch(/does not mean/);
    expect((await withKey(keyNoScope)('POST', '/v1/network/lookup', { chain: 'devnet', addresses: [] })).json().error.code).toBe('MISSING_SCOPE');
  });

  it('10-11. revocation propagates and stops the blocking match', async () => {
    const r = (await R.r2('POST', `/v1/admin/network/indicators/${indicatorId}/revoke`, { reason: 'delegate identified as a legitimate market maker vault' })).json();
    expect(r.indicator.status).toBe('REVOKED');
    await dispatchPending(getPool());
    expect(posts.some((x) => JSON.parse(x.body).type === 'threat.revoked')).toBe(true);
    const e = (await withKey(keyB)('POST', '/v1/transactions/evaluate', { transaction: approveTx(walletB) })).json();
    expect(e.decision).toBe('ALLOW');
    expect(e.intelligence.status).toBe('NO_KNOWN_MATCH');
    const hist = (await withKey(keyB)('GET', `/v1/network/indicators/${indicatorId}`)).json();
    expect(hist.history.map((h: any) => h.to)).toEqual(['SUSPECTED', 'UNDER_REVIEW', 'VERIFIED', 'REVOKED']);
    expect(hist.history[0].reviewerId).toBeUndefined(); // reviewer identities stay internal
  });

  it('keeps the review trail immutable, expires stale intelligence and corrects false positives', async () => {
    await expect(getPool().query(`UPDATE threat_reviews SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM intelligence_events`)).rejects.toThrow(/append-only/);
    // a second indicator: suspected by two orgs, then expired, then marked false positive
    const x = Keypair.generate().publicKey.toBase58();
    await B('PATCH', `${NET(orgB)}/subscriptions`, { sharingMode: 'ANONYMIZED_INTELLIGENCE' });
    await A('POST', `${NET(orgA)}/reports`, { chain: 'devnet', subject: { type: 'ADDRESS', value: x }, category: 'PHISHING_ADDRESS' });
    const weak = (await getPool().query('SELECT status FROM threat_indicators WHERE value = $1', [x])).rows[0];
    expect(weak.status).toBe('REPORTED'); // a report without evidence stays internal
    await R.r1('POST', '/v1/admin/network/observations', { chain: 'devnet', subject: { type: 'ADDRESS', value: x }, category: 'PHISHING_ADDRESS' });
    const ind = (await getPool().query('SELECT * FROM threat_indicators WHERE value = $1', [x])).rows[0];
    expect(ind.status).toBe('SUSPECTED');
    await getPool().query(`UPDATE threat_indicators SET expires_at = now() - interval '1 day' WHERE id = $1`, [ind.id]);
    expect(await expireDue(getPool())).toBe(1);
    expect((await getPool().query('SELECT status FROM threat_indicators WHERE id = $1', [ind.id])).rows[0].status).toBe('EXPIRED');
    const relBefore = (await getPool().query('SELECT reliability FROM network_settings WHERE org_id = $1', [orgA])).rows[0].reliability;
    await R.r3('POST', `/v1/admin/network/indicators/${ind.id}/review`, { reason: 'reopened after new questions' });
    const fp = (await R.r3('POST', `/v1/admin/network/indicators/${ind.id}/false-positive`, { reason: 'address belongs to a known exchange deposit' })).json();
    expect(fp.indicator.status).toBe('FALSE_POSITIVE');
    expect((await getPool().query('SELECT reliability FROM network_settings WHERE org_id = $1', [orgA])).rows[0].reliability).toBeLessThan(relBefore);
    const types = (await getPool().query('SELECT event_type FROM intelligence_events WHERE indicator_id = $1 ORDER BY sequence_number', [ind.id])).rows.map((r) => r.event_type);
    expect(types).toContain('threat.expired');
    expect(types).toContain('threat.false_positive');
  });

  it('exposes aggregate statistics without singling out participants, and a health check', async () => {
    const s = (await B('GET', `${NET(orgB)}/stats`)).json();
    expect(s.connectedOrganizations).toBeNull(); // fewer than the minimum cohort
    expect(s.matchesLast7Days).toBeNull();
    expect(JSON.stringify(s)).not.toMatch(/"[^"]*(saved|prevented|protected)[^"]*":/i); // no such metric
    const h = (await app.inject({ method: 'GET', url: '/v1/network/health' })).json();
    expect(h.ok).toBe(true);
    expect(h.intelligenceVersion).toBeGreaterThan(0);
    const act = (await withKey(keyB)('GET', '/v1/network/activity?after=0')).json().items;
    expect(act.length).toBeGreaterThan(3);
    expect(act.every((x: any, i: number) => i === 0 || x.intelligenceVersion > act[i - 1].intelligenceVersion)).toBe(true); // replayable, ordered
    const bad = await B('POST', `/v1/orgs/${orgB}/webhooks`, { url: 'https://127.0.0.1/hook', events: ['threat.verified'] });
    expect(bad.json().error.code).toBe('INVALID_WEBHOOK_URL');
  });
});
