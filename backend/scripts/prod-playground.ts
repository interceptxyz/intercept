// API Playground end-to-end against the deployed API: the six test scenarios, a sandboxed key route,
// and proof that production tables stay untouched. Removes every row it created.
import { getPool, closePool } from '../server/db';
import { login } from '../server/services/identity';

const BASE = process.env.BASE ?? 'https://api.intercepting.xyz';
const W = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', R = 'FmhXnxN8KDDFQExjrAYK6DiipL7sTTPPd78eDojSGRCW';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', JITO = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const P = (x: any = {}) => ({ risk: { maxTransactionValueUsd: '1000', ...x.risk }, security: { blockUnknownRecipients: false, ...x.security }, execution: { failClosed: true, ...x.execution } });
const SC: [string, any, any, string, string?][] = [
  ['A', { type: 'native_transfer', to: R, amountUsd: '500' }, P(), 'ALLOW'],
  ['B', { type: 'swap', mint: USDC, outputMint: JITO, amountUsd: '25000' }, P({ risk: { maxTransactionValueUsd: '100000', maxPositionSizeUsd: '10000', maxSlippageBps: 100 } }), 'DENY'],
  ['C', { type: 'swap', mint: USDC, outputMint: JITO, amountUsd: '50' }, P({ security: { allowedPrograms: ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'] } }), 'DENY'],
  ['D', { type: 'native_transfer', to: R, amountUsd: '1500' }, P({ risk: { maxTransactionValueUsd: '5000' }, execution: { requireApprovalAboveUsd: '1000' } }), 'REQUIRE_APPROVAL'],
  ['E', { type: 'token_approve', to: R, mint: USDC, unlimited: true }, P(), 'DENY'],
  ['F', { type: 'native_transfer', to: R, amountUsd: '800' }, P({ risk: { maxDailySpendUsd: '2000' } }), 'DENY', '1500'],
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const s = await login({ did: 'did:privy:pg-e2e-' + Date.now(), email: null, wallet: null }, 'prod-playground', null);
  const cookie = `icpt_session=${s.token}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(BASE + path, { method, headers: { cookie, origin: 'https://app.intercepting.xyz', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, j: await r.json().catch(() => ({})) as any };
  };
  let orgId = '', ok = 0, total = 0;
  const check = (n: string, c: boolean, d = '') => { total++; if (c) ok++; console.log(`${c ? '✔' : '✘'} ${n}${d ? '  ' + d : ''}`); };
  try {
    orgId = (await call('GET', '/v1/auth/session')).j.organizations[0].id;
    const run = (x: any) => call('POST', `/v1/orgs/${orgId}/playground/request`, x);
    let txA = '';
    for (const [k, b, policy, exp, assume] of SC) {
      const built = (await run({ method: 'POST', path: `/v1/orgs/${orgId}/playground/build`, body: { network: 'mainnet-beta', from: W, ...b } })).j;
      if (built.status !== 200) { check(`scenario ${k} build`, false, JSON.stringify(built.body?.error ?? built)); continue; }
      if (k === 'A') txA = built.body.transaction;
      const r = (await run({ method: 'POST', path: `/v1/orgs/${orgId}/playground/evaluate`, scenario: 'test-' + k.toLowerCase(), body: { network: 'mainnet-beta', wallet: W, transaction: built.body.transaction, policy, ...(assume ? { assume: { dailySpendUsd: assume } } : {}) } })).j;
      check(`scenario ${k} → ${r.body?.decision}`, r.status === 200 && r.body.decision === exp && r.body.sandbox === true && r.body.authorization === null,
        `${r.durationMs} ms · sim ${r.body?.simulation?.status} · ${(r.body?.reasons ?? []).map((x: any) => x.code).join(',') || 'no rule'}`);
      await sleep(2500);
    }
    // key route replayed through the Playground: real key auth, sandboxed result
    const a = (await call('POST', `/v1/orgs/${orgId}/agents`, { name: 'pg-e2e', wallet: W, network: 'mainnet-beta' })).j;
    const key = (await call('POST', `/v1/orgs/${orgId}/keys`, { agentId: a.id, name: 'pg', scopes: ['transactions:evaluate', 'agent:read'] })).j.key;
    const kr = (await run({ method: 'POST', path: '/v1/transactions/evaluate', apiKey: key, body: { transaction: txA } })).j;
    check('key route sandboxed', kr.status === 200 && kr.body.sandbox === true && kr.body.via === 'api_key', `${kr.body?.decision} · policy ${kr.body?.policy?.source} v${kr.body?.policy?.version}`);
    const bad = (await run({ method: 'GET', path: `/v1/orgs/${orgId}/keys` })).j;
    check('admin route refused', bad.error?.code === 'PLAYGROUND_ENDPOINT_NOT_ALLOWED');
    const db = getPool();
    const n = async (t: string) => Number((await db.query(`SELECT count(*) n FROM ${t} WHERE org_id = $1`, [orgId])).rows[0].n);
    check('no production evaluation, alert or authorization', (await n('evaluations')) + (await n('alerts')) + (await n('authorizations')) === 0);
    const h = (await call('GET', `/v1/orgs/${orgId}/playground/history`)).j.items;
    check('history recorded, key redacted', h.length >= 7 && !JSON.stringify(h).includes(key), `${h.length} entries`);
  } finally {
    const db = getPool();
    if (orgId) {
      for (const t of ['playground_requests', 'alerts', 'authorizations', 'evaluations', 'api_keys', 'agents', 'policy_versions', 'policies', 'memberships', 'audit_logs']) await db.query(`DELETE FROM ${t} WHERE org_id = $1`, [orgId]);
      await db.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await db.query('DELETE FROM sessions WHERE user_id = $1', [s.user.id]);
    await db.query('DELETE FROM users WHERE id = $1', [s.user.id]);
    console.log(`${ok}/${total} passed; test rows removed`);
    await closePool();
  }
}
main();
