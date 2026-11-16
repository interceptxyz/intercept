import { Pool, PoolClient, QueryResultRow } from 'pg';
import { MIGRATIONS } from './schema';

export type Db = Pool | PoolClient;

let pool: Pool | null = null;
let migrated: Promise<void> | null = null;

export function getPool(url = process.env.DATABASE_URL): Pool {
  if (!pool) {
    if (!url) throw new Error('DATABASE_URL is not configured');
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 3),
      idleTimeoutMillis: 10_000,
      ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined,
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; migrated = null; }
}

export async function q<T extends QueryResultRow = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
export async function one<T extends QueryResultRow = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await db.query<T>(sql, params)).rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>, p = getPool()): Promise<T> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Idempotent, serialized across concurrent cold starts by an advisory lock. */
export function migrate(p = getPool()): Promise<void> {
  if (!migrated) {
    migrated = tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(918273645)');
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        await c.query(m.sql);
        await c.query('INSERT INTO schema_migrations(id) VALUES ($1)', [m.id]);
      }
    }, p).catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}
