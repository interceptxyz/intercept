import { FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodTypeAny } from 'zod';
import { getPool, one } from '../db';
import { config } from '../lib/config';
import { HttpError, bad, forbidden, notFound } from '../lib/util';
import { SESSION_COOKIE, requireSessionUser } from '../services/identity';
import { KeyPrincipal, KeyScope, authenticateKey, rateLimit, requireScope } from '../services/keys';

export type Role = 'OWNER' | 'ADMIN' | 'VIEWER';
const RANK: Record<Role, number> = { VIEWER: 0, ADMIN: 1, OWNER: 2 };

export function cookie(req: FastifyRequest, name: string): string | null {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAge: number) {
  const secure = config().cookieSecure ? '; Secure' : '';
  reply.header('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

/** Cookie-authenticated mutations must come from an allowed origin (CSRF). */
function checkOrigin(req: FastifyRequest) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const origin = req.headers.origin;
  if (!origin || !config().origins.has(origin)) throw forbidden('Cross-site request rejected.', 'BAD_ORIGIN');
}

export async function user(req: FastifyRequest) {
  const u = await requireSessionUser(getPool(), cookie(req, SESSION_COOKIE));
  checkOrigin(req);
  return u;
}

/** Session user + membership check: every org-scoped route goes through this (tenant isolation). */
export async function member(req: FastifyRequest, min: Role = 'VIEWER') {
  const u = await user(req);
  const orgId = (req.params as any).orgId as string;
  const m = await one(getPool(), 'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, u.id]);
  if (!m) throw notFound('Organization'); // no existence oracle across tenants
  if (RANK[m.role as Role] < RANK[min]) throw forbidden(`This requires the ${min} role; you are ${m.role}.`);
  return { user: u, orgId, role: m.role as Role };
}

/** Agent API key: never grants any administrative route. */
export async function agentKey(req: FastifyRequest, scope: KeyScope): Promise<KeyPrincipal> {
  const p = await authenticateKey(getPool(), req.headers.authorization);
  await rateLimit(getPool(), `key:${p.keyId}`, p.rateLimitPerMin);
  requireScope(p, scope);
  return p;
}

export function body<T extends ZodTypeAny>(req: FastifyRequest, schema: T): z.infer<T> {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) throw bad('INVALID_REQUEST', 'The request body is invalid.', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export const ip = (req: FastifyRequest) => req.ip ?? null;
export { HttpError };
