// End-to-end against the deployed API, then removes every row it created.
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import { getPool, closePool } from '../server/db';
import { login } from '../server/services/identity';

const BASE = process.env.BASE ?? 'https://api.intercepting.xyz';
const WHALE = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const results: [string, boolean, string][] = [];
const check = (n: string, ok: boolean, d = '') => { results.push([n, ok, d]); console.log(`${ok ? '✔' : '✘'} ${n}${d ? '  ' + d : ''}`); };
const tx = (ixs: TransactionInstruction[]) => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: WHALE, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message()).serialize()).toString('base64');

async function main() {
  const s = await login({ did: 'did:privy:e2e-' + Date.now(), email: null, wallet: null }, 'prod-e2e', null);
  const cookie = `icpt_session=${s.token}`;
  const call = async (method: string, path: string, body?: unknown, auth?: string) => {
    const r = await fetch(BASE + path, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : { cookie, origin: 'https://app.intercepting.xyz' }), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, j: await r.json().catch(() => ({})) as any };
  };
  let orgId = '';
  try {
    const sess = (await call('GET', '/v1/auth/session')).j;
    orgId = sess.organizations[0].id;
    check('session + personal organization', !!orgId && sess.organizations[0].role === 'OWNER');
    const friend = Keypair.generate().publicKey.toBase58();
    const a = (await call('POST', `/v1/orgs/${orgId}/agents`, { name: 'e2e-mainnet', wallet: WHALE.toBase58(), network: 'mainnet-beta' })).j;
    check('agent registered', a.status === 'ACTIVE', a.id);
    const v = (await call('POST', `/v1/orgs/${orgId}/policies/${a.policy.id}/versions`, { config: { risk: { maxTransactionValueUsd: '1000', maxDailySpendUsd: '5000' }, security: { allowedRecipients: [friend] }, execution: { requireApprovalAboveUsd: '500' } } })).j;
    check('policy v2', v.version === 2);
    const k = (await call('POST', `/v1/orgs/${orgId}/keys`, { agentId: a.id, name: 'e2e', scopes: ['transactions:evaluate', 'transactions:read'] })).j;
    check('live key issued once', /^icpt_live_/.test(k.key));
    const ev = async (label: string, ixs: TransactionInstruction[], want: string) => {
      const t0 = Date.now();
      const r = await call('POST', '/v1/transactions/evaluate', { transaction: tx(ixs) }, k.key);
      check(`${label} → ${want}`, r.j.decision === want, `${r.j.decision} ${r.j.valueUsd ?? ''} USD sim=${r.j.simulation?.status} slot=${r.j.simulation?.slot} ${(r.j.reasons ?? []).map((x: any) => x.code).join(',')} ${Date.now() - t0}ms`);
      return r.j;
    };
    await ev('0.5 SOL to allowlisted', [SystemProgram.transfer({ fromPubkey: WHALE, toPubkey: new PublicKey(friend), lamports: 500_000_000 })], 'ALLOW');
    await ev('9 SOL to allowlisted (above approval threshold)', [SystemProgram.transfer({ fromPubkey: WHALE, toPubkey: new PublicKey(friend), lamports: 9_000_000_000 })], 'REQUIRE_APPROVAL');
    await ev('30 SOL (above max)', [SystemProgram.transfer({ fromPubkey: WHALE, toPubkey: new PublicKey(friend), lamports: 30_000_000_000 })], 'DENY');
    await ev('0.1 SOL to unknown recipient', [SystemProgram.transfer({ fromPubkey: WHALE, toPubkey: Keypair.generate().publicKey, lamports: 100_000_000 })], 'DENY');
    check('agent key cannot reach admin routes', (await call('GET', `/v1/orgs/${orgId}/agents`, undefined, k.key)).status === 401);
    check('scope enforced', (await call('POST', '/v1/execution/requests', { transaction: 'x'.repeat(100) }, k.key)).j.error?.code === 'MISSING_SCOPE');
    const list = (await call('GET', '/v1/transactions', undefined, k.key)).j;
    check('history readable with transactions:read', Array.isArray(list) && list.length === 4);
    const m = (await call('GET', `/v1/orgs/${orgId}/metrics`)).j;
    check('metrics', m.decisions.ALLOW === 1 && m.pendingApprovals === 1, JSON.stringify(m.decisions));
  } finally {
    // cleanup
    const db = getPool();
    if (orgId) {
      for (const t of ['webhook_deliveries', 'webhooks', 'alerts', 'authorizations', 'evaluations', 'api_keys', 'wallet_challenges', 'agents', 'policy_versions', 'policies', 'invitations', 'memberships', 'audit_logs']) await db.query(`DELETE FROM ${t} WHERE org_id = $1`, [orgId]);
      await db.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await db.query('DELETE FROM sessions WHERE user_id = $1', [s.user.id]);
    await db.query('DELETE FROM users WHERE id = $1', [s.user.id]);
    await db.query(`DELETE FROM rate_windows`);
    await closePool();
  }
  const bad = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
