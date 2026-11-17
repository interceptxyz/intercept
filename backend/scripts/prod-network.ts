// Intercept Network against the deployed API (temporary organization, private report: nothing is published). Removes its rows.
import { getPool, closePool } from '../server/db';
import { login } from '../server/services/identity';
const BASE = process.env.BASE ?? 'https://api.intercepting.xyz';
async function main() {
  const s = await login({ did: 'did:privy:net-e2e-' + Date.now(), email: null, wallet: null }, 'prod-network', null);
  const h = { cookie: `icpt_session=${s.token}`, origin: 'https://app.intercepting.xyz' };
  const call = async (m: string, p: string, b?: unknown, auth?: string) => { const r = await fetch(BASE + p, { method: m, headers: auth ? { authorization: `Bearer ${auth}`, 'content-type': 'application/json' } : { ...h, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) as any }; };
  let ok = 0, total = 0, orgId = '';
  const check = (n: string, c: boolean, d = '') => { total++; if (c) ok++; console.log(`${c ? '✔' : '✘'} ${n}${d ? '  ' + d : ''}`); };
  try {
    orgId = (await call('GET', '/v1/auth/session')).j.organizations[0].id;
    const a = (await call('POST', `/v1/orgs/${orgId}/agents`, { name: 'net-e2e', wallet: 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', network: 'mainnet-beta' })).j;
    const key = (await call('POST', `/v1/orgs/${orgId}/keys`, { agentId: a.id, name: 'n', scopes: ['network:read', 'network:report'] })).j.key;
    const sub = (await call('GET', `/v1/orgs/${orgId}/network/subscriptions`)).j;
    check('default sharing is PRIVATE', sub.sharingMode === 'PRIVATE');
    const rep = await call('POST', '/v1/network/reports', { chain: 'eip155:4663', subject: { type: 'ADDRESS', value: '0x3FFC2B2DAA6B59ABC622DB1A0952589236C22102' }, category: 'SUSPICIOUS_PATTERN',
      txHash: '0x64f09400084baefa33bda9535bd15582867a29ecff865ded2871df9413d106dd', description: 'prod smoke test, not a real threat' }, key);
    check('report on Robinhood Chain, tx verified on chain, kept private', rep.s === 201 && rep.j.processingStatus === 'PRIVATE' && rep.j.evidenceCheck?.found === true && rep.j.evidenceCheck?.involvesSubject === true,
      `${rep.j.evidenceCheck?.status} block ${rep.j.evidenceCheck?.block}`);
    const lk = await call('POST', '/v1/network/lookup', { chain: 'eip155:4663', addresses: ['0xd893177bfe31e786b3e13734c3d7eabc6f786cb4'] }, key);
    check('Robinhood Chain lookup', lk.s === 200 && lk.j.status === 'NO_KNOWN_MATCH', `${lk.j.lookupMs} ms, proxies ${lk.j.proxies?.length}`);
    const lk2 = await call('POST', '/v1/network/lookup', { chain: 'mainnet-beta', addresses: ['H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'] }, key);
    check('mainnet lookup', lk2.j.status === 'NO_KNOWN_MATCH', `${lk2.j.lookupMs} ms`);
    const ind = await call('GET', '/v1/network/indicators', undefined, key);
    check('registry readable, private report not published', ind.s === 200 && !JSON.stringify(ind.j).includes('3ffc2b2d'));
    const adm = await call('GET', '/v1/admin/network/reviews');
    check('admin queue refused to non-reviewers', adm.j.error?.code === 'NOT_A_REVIEWER');
    const st = await call('GET', `/v1/orgs/${orgId}/network/stats`);
    check('stats', st.s === 200 && st.j.minimumCohort >= 3);
  } finally {
    const db = getPool();
    if (orgId) {
      for (const t of ['threat_evidence WHERE observation_id IN (SELECT id FROM threat_observations WHERE org_id = $1)', 'threat_observations WHERE org_id = $1', 'network_settings WHERE org_id = $1', 'audit_logs WHERE org_id = $1', 'api_keys WHERE org_id = $1', 'agents WHERE org_id = $1', 'policy_versions WHERE org_id = $1', 'policies WHERE org_id = $1', 'memberships WHERE org_id = $1', 'organizations WHERE id = $1'])
        await db.query(`DELETE FROM ${t}`, [orgId]);
    }
    await db.query('DELETE FROM sessions WHERE user_id = $1', [s.user.id]); await db.query('DELETE FROM users WHERE id = $1', [s.user.id]);
    console.log(`${ok}/${total} passed; test rows removed`); await closePool();
  }
}
main();
