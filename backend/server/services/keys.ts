/**
 * Agent API keys: icpt_<test|live>_<8-char public id><40-char secret>, base62.
 * The first 18 characters (icpt_live_ + id) are the non-secret prefix used for lookup and display;
 * only HMAC-SHA256(pepper, key) is stored. The full key is returned once, at creation.
 */
import { randomBytes } from 'crypto';
import { Db, one, q } from '../db';
import { config } from '../lib/config';
import { HttpError, bad, hmac, notFound, safeEqualHex, unauthorized } from '../lib/util';

export const KEY_SCOPES = ['transactions:evaluate', 'transactions:read', 'execution:request', 'agent:read'] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function base62(n: number) {
  let s = '';
  while (s.length < n) for (const b of randomBytes(n * 2)) { if (b < 248 && s.length < n) s += B62[b % 62]; }
  return s;
}

export function generateKey(environment: 'test' | 'live') {
  const key = `icpt_${environment}_${base62(8)}${base62(40)}`;
  return { key, prefix: key.slice(0, `icpt_${environment}_`.length + 8) };
}

const KEY_RE = /^icpt_(test|live)_[0-9A-Za-z]{48}$/;

export interface KeyPrincipal {
  keyId: string; orgId: string; agentId: string; environment: 'test' | 'live'; scopes: Set<KeyScope>; rateLimitPerMin: number;
}

export async function authenticateKey(db: Db, header: string | undefined): Promise<KeyPrincipal> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!KEY_RE.test(token)) throw unauthorized('Send Authorization: Bearer icpt_test_… or icpt_live_…', 'INVALID_API_KEY');
  const env = token.startsWith('icpt_live_') ? 'live' : 'test';
  const prefix = token.slice(0, `icpt_${env}_`.length + 8);
  const k = await one(db, `SELECT k.*, a.status AS agent_status FROM api_keys k JOIN agents a ON a.id = k.agent_id WHERE k.prefix = $1`, [prefix]);
  if (!k || !safeEqualHex(k.digest, hmac(config().pepper, token))) throw unauthorized('Invalid API key.', 'INVALID_API_KEY');
  if (k.revoked_at) throw unauthorized('This API key was revoked.', 'API_KEY_REVOKED');
  if (k.expires_at && new Date(k.expires_at) <= new Date()) throw unauthorized('This API key has expired.', 'API_KEY_EXPIRED');
  if (k.agent_status === 'REVOKED') throw unauthorized('The agent of this key is revoked.', 'AGENT_REVOKED');
  void db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]).catch(() => undefined);
  return { keyId: k.id, orgId: k.org_id, agentId: k.agent_id, environment: k.environment, scopes: new Set(k.scopes), rateLimitPerMin: k.rate_limit_per_min };
}

export function requireScope(p: KeyPrincipal, scope: KeyScope) {
  if (!p.scopes.has(scope)) throw new HttpError(403, 'MISSING_SCOPE', `This API key lacks the "${scope}" scope.`);
}

/** Fixed one-minute window counter in Postgres (works across serverless instances). */
export async function rateLimit(db: Db, key: string, perMin: number) {
  const row = await one(db, `INSERT INTO rate_windows(key, window_start, count) VALUES ($1, date_trunc('minute', now()), 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_windows.count + 1 RETURNING count`, [key]);
  if (Number(row!.count) > perMin) throw new HttpError(429, 'RATE_LIMITED', `Rate limit of ${perMin} requests per minute exceeded.`);
  if (Math.random() < 0.01) void db.query(`DELETE FROM rate_windows WHERE window_start < now() - interval '10 minutes'`).catch(() => undefined);
}

export interface CreateKey { agentId: string; name: string; scopes: KeyScope[]; rateLimitPerMin: number; expiresAt: Date | null }

export async function createKey(db: Db, orgId: string, userId: string, input: CreateKey, rotatedFrom: string | null = null) {
  const agent = await one(db, 'SELECT * FROM agents WHERE id = $1 AND org_id = $2', [input.agentId, orgId]);
  if (!agent) throw notFound('Agent');
  if (agent.status === 'REVOKED') throw bad('AGENT_REVOKED', 'Keys cannot be created for a revoked agent.');
  const active = await one(db, 'SELECT count(*)::int n FROM api_keys WHERE org_id = $1 AND revoked_at IS NULL', [orgId]);
  if (active!.n >= 100) throw bad('KEY_LIMIT', 'At most 100 active keys per organization.');
  const environment = agent.network === 'mainnet-beta' ? 'live' : 'test';
  const { key, prefix } = generateKey(environment);
  const id = `key_${prefix.slice(-8)}`;
  await q(db, `INSERT INTO api_keys(id, org_id, agent_id, name, environment, prefix, digest, scopes, rate_limit_per_min, expires_at, rotated_from, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, orgId, agent.id, input.name, environment, prefix, hmac(config().pepper, key), input.scopes, input.rateLimitPerMin, input.expiresAt, rotatedFrom, userId]);
  return { id, key, prefix, environment };
}

export const keyView = (k: any) => ({
  id: k.id, agentId: k.agent_id, name: k.name, environment: k.environment, prefix: k.prefix, scopes: k.scopes,
  rateLimitPerMin: k.rate_limit_per_min, expiresAt: k.expires_at, revokedAt: k.revoked_at, rotatedFrom: k.rotated_from,
  lastUsedAt: k.last_used_at, createdAt: k.created_at,
});
