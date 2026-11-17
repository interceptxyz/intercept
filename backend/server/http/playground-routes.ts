/** API Playground (console session). Sandbox only: see services/playground.ts. */
import { FastifyInstance } from 'fastify';
import { getPool, q } from '../db';
import { rateLimit } from '../services/keys';
import { audit } from '../services/audit';
import { buildSchema, buildTransaction, execute, history, historyItem, requestSchema, sandboxEvaluate, sandboxSchema } from '../services/playground';
import { body, ip, member } from './context';

const PER_MIN = Number(process.env.PLAYGROUND_RATE_PER_MIN ?? 60);

export function playgroundRoutes(app: FastifyInstance) {
  const db = getPool();

  app.post('/v1/orgs/:orgId/playground/evaluate', async (req) => {
    const m = await member(req);
    await rateLimit(db, `pg-eval:${m.user.id}`, PER_MIN);
    const b = body(req, sandboxSchema);
    return sandboxEvaluate(db, { ...b, orgId: m.orgId, via: 'console_session' });
  });

  app.post('/v1/orgs/:orgId/playground/build', async (req) => {
    const m = await member(req);
    await rateLimit(db, `pg-build:${m.user.id}`, PER_MIN);
    return buildTransaction(body(req, buildSchema));
  });

  app.post('/v1/orgs/:orgId/playground/request', async (req) => {
    const m = await member(req);
    await rateLimit(db, `pg:${m.user.id}`, PER_MIN);
    const x = body(req, requestSchema);
    const out = await execute(app, db, req, { orgId: m.orgId, userId: m.user.id }, x);
    if (out.endpoint !== 'playground.build') {
      await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'playground.request', targetType: 'endpoint', targetId: `${x.method} ${out.endpoint}`,
        detail: { status: out.status, durationMs: out.durationMs, scenario: x.scenario ?? null, sandboxed: out.sandboxed }, ip: ip(req) });
    }
    return out;
  });

  app.get('/v1/orgs/:orgId/playground/history', async (req) => {
    const m = await member(req);
    const qs = req.query as any;
    return { items: await history(db, m.orgId, m.user.id, typeof qs.filter === 'string' ? qs.filter : null, Math.min(Number(qs.limit) || 50, 200)) };
  });
  app.get('/v1/orgs/:orgId/playground/history/:id', async (req) => {
    const m = await member(req);
    return historyItem(db, m.orgId, m.user.id, (req.params as any).id);
  });
  app.delete('/v1/orgs/:orgId/playground/history', async (req) => {
    const m = await member(req);
    const r = await q(db, 'DELETE FROM playground_requests WHERE org_id = $1 AND user_id = $2 RETURNING id', [m.orgId, m.user.id]);
    return { deleted: r.length };
  });
}
