import { getPool, closePool } from '../server/db';
import { login } from '../server/services/identity';
(async () => {
  const s = await login({ did: 'did:privy:watch-e2e-' + Date.now(), email: null, wallet: null }, 'e2e', null);
  const cookie = `icpt_session=${s.token}`;
  const call = async (m: string, p: string, b?: unknown) => { const r = await fetch('https://api.intercepting.xyz' + p, { method: m, headers: { cookie, origin: 'https://app.intercepting.xyz', ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, j: await r.json() as any }; };
  let orgId = '';
  try {
    orgId = (await call('GET', '/v1/auth/session')).j.organizations[0].id;
    const t0 = Date.now();
    const w = await call('POST', `/v1/orgs/${orgId}/wallets`, { address: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', label: 'e2e', network: 'mainnet-beta', rules: { incoming: true } });
    console.log('add', w.status, w.j.id, w.j.lastError ?? 'no error', Date.now() - t0, 'ms');
    const ev = await call('GET', `/v1/orgs/${orgId}/wallets/${w.j.id}/events`);
    console.log('events', ev.j.length, ev.j.map((e: any) => e.direction[0]).join(''));
    const rf = await call('POST', `/v1/orgs/${orgId}/wallets/${w.j.id}/refresh`);
    console.log('refresh', rf.status, rf.j.newEvents);
  } finally {
    const db = getPool();
    if (orgId) {
      for (const t of ['watch_events', 'watched_wallets', 'alerts', 'policy_versions', 'policies', 'memberships', 'audit_logs']) await db.query(`DELETE FROM ${t} WHERE org_id = $1`, [orgId]);
      await db.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await db.query('DELETE FROM sessions WHERE user_id = $1', [s.user.id]); await db.query('DELETE FROM users WHERE id = $1', [s.user.id]);
    await closePool();
  }
})();
