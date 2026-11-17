/** Routes for agents: Authorization: Bearer icpt_test_… / icpt_live_…  (scoped, rate limited, no admin). */
import { FastifyInstance } from 'fastify';
import { sign as edSign } from 'crypto';
import { z } from 'zod';
import { getPool, one, q } from '../db';
import { config } from '../lib/config';
import { HttpError, notFound } from '../lib/util';
import { attempt } from '../services/webhooks';
import { consumeAuthorization, evaluate, evaluationView, getEvaluation } from '../services/evaluations';
import { agentKey, body, ip } from './context';
import { waitUntil } from '@vercel/functions';
import { feed, refreshScan, stats } from '../services/feed';
import { tick } from '../services/watch';
import { isPlayground, sandboxEvaluate } from '../services/playground';

const txBody = z.object({ transaction: z.string().min(80).max(2000), reference: z.string().max(100).optional() });

export function agentRoutes(app: FastifyInstance) {
  const db = getPool();

  // ---------------------------------------------------------------- public live feed (no auth)
  const kick = () => { const p = Promise.all([refreshScan(db).catch(() => 0), tick(db).catch(() => null)]); try { waitUntil(p); } catch { /* not on Vercel */ } };
  app.get('/v1/public/feed', async (req, reply) => {
    kick();
    const qs = req.query as any;
    const since = typeof qs.since === 'string' && !isNaN(Date.parse(qs.since)) ? new Date(qs.since).toISOString() : null;
    reply.header('cache-control', 'public, max-age=3');
    return { items: await feed(db, Math.min(Number(qs.limit) || 40, 100), since) };
  });
  app.get('/v1/public/stats', async (_req, reply) => {
    kick();
    reply.header('cache-control', 'public, max-age=10');
    return stats(db);
  });

  app.get('/v1/.well-known/intercept-keys', async () => {
    const c = config();
    return { keys: [{ kid: c.keyId, alg: 'Ed25519', publicKey: c.publicKeyB64, use: 'execution-authorization' }] };
  });

  app.get('/v1/agent', async (req) => {
    const p = await agentKey(req, 'agent:read');
    const a = await one(db, 'SELECT * FROM agents WHERE id = $1 AND org_id = $2', [p.agentId, p.orgId]);
    const v = await one(db, 'SELECT config FROM policy_versions WHERE policy_id = $1 AND version = $2', [a.policy_id, a.policy_version]);
    return { id: a.id, name: a.name, network: a.network, status: a.status, integrationMode: a.integration_mode, wallet: a.wallet, walletVerified: !!a.wallet_verified_at,
      policy: { id: a.policy_id, version: a.policy_version, config: v?.config }, key: { id: p.keyId, environment: p.environment, scopes: [...p.scopes] } };
  });

  const run = async (req: any, kind: 'evaluate' | 'execution_request') => {
    const p = await agentKey(req, kind === 'evaluate' ? 'transactions:evaluate' : 'execution:request');
    const agent = await one(db, 'SELECT network FROM agents WHERE id = $1', [p.agentId]);
    // test keys are for devnet agents, live keys for mainnet agents (fixed at key creation)
    if ((agent.network === 'mainnet-beta') !== (p.environment === 'live')) throw new HttpError(403, 'ENVIRONMENT_MISMATCH', 'Key environment does not match the agent network.');
    const b = body(req, txBody);
    // requests replayed by the API Playground: same key, scope, rate limit and engine, nothing recorded or authorized
    if (isPlayground(req)) return { ...(await sandboxEvaluate(db, { orgId: p.orgId, agentId: p.agentId, transaction: b.transaction, kind, via: 'api_key' })), reference: b.reference ?? null };
    const out = await evaluate(db, { orgId: p.orgId, agentId: p.agentId, transaction: b.transaction, source: 'api', kind, apiKeyId: p.keyId, actorId: p.keyId, reference: b.reference, ip: ip(req) });
    for (const d of out.result.deliveries) await attempt(db, d).catch(() => undefined);
    return { ...out.row, authorization: out.result.authorization ?? out.row.authorization };
  };
  app.post('/v1/transactions/evaluate', async (req) => run(req, 'evaluate'));
  app.post('/v1/execution/requests', async (req) => run(req, 'execution_request'));

  app.get('/v1/transactions', async (req) => {
    const p = await agentKey(req, 'transactions:read');
    const limit = Math.min(Number((req.query as any).limit) || 50, 200);
    const rows = await q(db, 'SELECT * FROM evaluations WHERE org_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3', [p.orgId, p.agentId, limit]);
    return rows.map((e) => ({ ...evaluationView(e), decoded: undefined, simulation: undefined }));
  });
  app.get('/v1/transactions/:id', async (req) => {
    const p = await agentKey(req, 'transactions:read');
    const e = await getEvaluation(db, p.orgId, (req.params as any).id);
    if (e.agentId !== p.agentId) throw notFound('Evaluation');
    return e;
  });

  /** Poll an execution request; once approved, returns a fresh authorization token (once). */
  app.get('/v1/execution/requests/:id', async (req) => {
    const p = await agentKey(req, 'execution:request');
    const e = await getEvaluation(db, p.orgId, (req.params as any).id);
    if (e.agentId !== p.agentId || e.kind !== 'execution_request') throw notFound('Execution request');
    let token: string | null = null;
    if (e.approval?.status === 'APPROVED' && e.authorization && !e.authorization.consumedAt) {
      // tokens are only returned to the agent; re-sign the stored authorization claims
      const a = await one(db, 'SELECT a.*, e.network FROM authorizations a JOIN evaluations e ON e.id = a.evaluation_id WHERE a.id = $1', [e.authorization.id]);
      token = resignToken(a);
    }
    return { ...e, decoded: undefined, simulation: undefined, authorizationToken: token };
  });

  app.post('/v1/execution/authorizations/:id/consume', async (req) => {
    const p = await agentKey(req, 'execution:request');
    const b = body(req, z.object({ messageHash: z.string().regex(/^[0-9a-f]{64}$/) }));
    return consumeAuthorization(db, p.orgId, p.agentId, (req.params as any).id, b.messageHash);
  });
  app.post('/v1/execution/authorizations/:id/report', async (req) => {
    const p = await agentKey(req, 'execution:request');
    const b = body(req, z.object({ signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) }));
    const r = await q(db, 'UPDATE authorizations SET signature = $4 WHERE id = $1 AND org_id = $2 AND agent_id = $3 AND consumed_at IS NOT NULL RETURNING id', [(req.params as any).id, p.orgId, p.agentId, b.signature]);
    if (!r.length) throw notFound('Consumed authorization');
    return { ok: true };
  });
}

function resignToken(a: any) {
  const c = config();
  const payload = { v: 1, kid: c.keyId, aid: a.id, eid: a.evaluation_id, org: a.org_id, agent: a.agent_id, net: a.network, mh: a.message_hash, iat: Math.floor(new Date(a.created_at).getTime() / 1000), exp: Math.floor(new Date(a.expires_at).getTime() / 1000) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${edSign(null, Buffer.from(body), c.signingKey).toString('base64url')}`;
}
