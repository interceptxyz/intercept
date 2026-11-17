// Grant or revoke the Intercept Network reviewer role: npx tsx scripts/grant-reviewer.ts <email|userId> [REVIEWER|LEAD|revoke]
import { getPool, closePool, one } from '../server/db';
(async () => {
  const [who, role = 'REVIEWER'] = process.argv.slice(2);
  if (!who) throw new Error('usage: grant-reviewer.ts <email|userId> [REVIEWER|LEAD|revoke]');
  const db = getPool();
  const u = await one(db, 'SELECT id, email FROM users WHERE id = $1 OR lower(email) = lower($1)', [who]);
  if (!u) throw new Error('user not found (they must sign in to the console once)');
  if (role === 'revoke') await db.query('DELETE FROM network_reviewers WHERE user_id = $1', [u.id]);
  else await db.query(`INSERT INTO network_reviewers(user_id, role, granted_by) VALUES ($1,$2,'script') ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`, [u.id, role]);
  console.log(role === 'revoke' ? 'revoked' : `granted ${role}`, u.email ?? u.id);
  await closePool();
})();
