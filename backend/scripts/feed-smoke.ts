import { getPool, migrate, closePool } from '../server/db';
import { feed, refreshScan, stats } from '../server/services/feed';
(async () => {
  await migrate();
  const db = getPool();
  await db.query(`DELETE FROM kv_state WHERE key = 'feed_scan'`);
  const t0 = Date.now();
  let n = 0; for (let k = 0; k < 2; k++) { n += await refreshScan(db); await db.query(`DELETE FROM kv_state WHERE key = 'feed_scan'`); }
  await db.query(`DELETE FROM kv_state WHERE key = 'feed_scan'`);
  const n2 = await refreshScan(db);
  console.log('scanned', n, n2, 'in', Date.now() - t0, 'ms');
  for (const i of await feed(db, 10, null)) console.log(i.decision.padEnd(16), (i.valueUsd ?? '?').toString().padStart(10), i.programs.join('+').slice(0, 50).padEnd(50), i.kinds.join(','), '|', i.reasons.join(','), '|', i.simulation, i.signature?.slice(0, 10));
  console.log(await stats(db));
  await closePool();
})();
