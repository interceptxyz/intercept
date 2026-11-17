/**
 * Intercept Network API.
 *   /v1/network/*            agent API keys (scopes network:read, network:report)
 *   /v1/orgs/:orgId/network/* console session (organization roles)
 *   /v1/admin/network/*      network security reviewers only
 *   /v1/network/health       public, no customer data
 */
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool, one, q } from '../db';
import { forbidden } from '../lib/util';
import { audit } from '../services/audit';
import { CATEGORIES, CHAINS, Chain, INDICATOR_TYPES, NormalizeError, SEVERITIES, SHARING, STATUSES, isChain, normalizeValue, sevRank } from '../network/model';
import { ACTIONS, ReviewAction } from '../network/lifecycle';
import { activity, deleteObservation, indicatorDetail, indicatorView, ingest, isReviewer, listIndicators, reportStatus, review, settings, settingsView } from '../network/service';
import { lookup } from '../network/matching';
import { evmCode } from '../network/chains';
import { health, stats } from '../network/analytics';
import { agentKey, body, ip, member, user } from './context';
import { rateLimit } from '../services/keys';
import { bad } from '../lib/util';

const chain = z.string().refine(isChain, `one of ${Object.keys(CHAINS).join(', ')}`) as unknown as z.ZodType<Chain>;
const reportSchema = z.object({
  chain, subject: z.object({ type: z.enum(INDICATOR_TYPES), value: z.string().min(1).max(200) }).strict(), category: z.enum(CATEGORIES),
  txHash: z.string().max(120).optional(), description: z.string().max(1000).optional(), evidence: z.record(z.unknown()).optional(),
  observedAt: z.string().datetime().optional(), agentId: z.string().max(40).optional(),
}).strict();
const lookupSchema = z.object({ chain, addresses: z.array(z.string().max(120)).max(100).default([]), txHashes: z.array(z.string().max(120)).max(50).default([]), resolveProxies: z.boolean().default(true) }).strict();
const listQuery = (qs: any) => ({
  chain: typeof qs.chain === 'string' ? qs.chain : undefined, type: typeof qs.type === 'string' ? qs.type : undefined, category: typeof qs.category === 'string' ? qs.category : undefined,
  minSeverity: SEVERITIES.includes(qs.minSeverity) ? qs.minSeverity : undefined, minConfidence: qs.minConfidence !== undefined && !isNaN(Number(qs.minConfidence)) ? Number(qs.minConfidence) : undefined,
  status: typeof qs.status === 'string' ? qs.status.split(',').filter((s: string) => (STATUSES as readonly string[]).includes(s)) : undefined,
  value: typeof qs.value === 'string' ? qs.value : undefined, updatedSince: typeof qs.updatedSince === 'string' && !isNaN(Date.parse(qs.updatedSince)) ? new Date(qs.updatedSince).toISOString() : undefined,
  before: typeof qs.before === 'string' && !isNaN(Date.parse(qs.before)) ? new Date(qs.before).toISOString() : undefined, limit: Math.min(Number(qs.limit) || 50, 200),
});
/** Network recommendation only: the organization's policy decides. */
const recommend = (i: any) => i.status === 'VERIFIED' ? (sevRank(i.severity) >= sevRank('HIGH') && i.confidence >= 70 ? 'BLOCK' : 'REQUIRE_APPROVAL') : i.status === 'SUSPECTED' ? 'WARN' : 'INFORMATIONAL';

export function networkRoutes(app: FastifyInstance) {
  const db = getPool();

  // ---------------------------------------------------------------- shared handlers
  const doLookup = async (orgId: string, b: z.infer<typeof lookupSchema>) => {
    await rateLimit(db, `net-lookup:${orgId}`, 600);
    const invalid: { value: string; error: string }[] = [];
    const subjects: { value: string; field: string; via?: string }[] = [];
    for (const a of b.addresses) { try { subjects.push({ value: normalizeValue(b.chain, 'ADDRESS', a), field: 'address' }); } catch (e) { if (e instanceof NormalizeError) invalid.push({ value: a, error: e.message }); else throw e; } }
    const proxies: any[] = [];
    if (b.resolveProxies && CHAINS[b.chain].family === 'evm') {
      for (const s of subjects.slice(0, 20)) {
        const c = await evmCode(b.chain, s.value).catch(() => null);
        if (c?.implementation) { subjects.push({ value: c.implementation, field: 'proxy_implementation', via: s.value }); proxies.push({ proxy: s.value, implementation: c.implementation, standard: 'EIP-1967' }); }
      }
    }
    const txs: string[] = [];
    for (const t of b.txHashes) { try { txs.push(normalizeValue(b.chain, 'TX_HASH', t)); } catch (e) { if (e instanceof NormalizeError) invalid.push({ value: t, error: e.message }); else throw e; } }
    try {
      const r = await lookup(db, b.chain, subjects.map((s) => s.value));
      const txRows = txs.length ? await q(db, `SELECT * FROM threat_indicators WHERE chain = $1 AND indicator_type = 'TX_HASH' AND value = ANY($2) AND status IN ('SUSPECTED','VERIFIED','DISPUTED')`, [b.chain, txs]) : [];
      const matches = [...subjects.flatMap((s) => (r.matches.get(s.value) ?? []).map((i) => ({ i, s }))), ...txRows.map((i) => ({ i, s: { value: i.value, field: 'tx_hash' } as any }))]
        .map(({ i, s }) => ({ indicatorId: i.id, value: s.value, matchedField: s.field, via: s.via ?? null, indicatorType: i.indicator_type, category: i.category, severity: i.severity, confidence: i.confidence, status: i.status, recommendedAction: recommend(i), intelligenceVersion: Number(i.intelligence_version) }));
      return { status: matches.length ? 'MATCH_FOUND' : 'NO_KNOWN_MATCH', note: matches.length ? 'recommendedAction is the network recommendation; your policy decides.' : 'No known match. This does not mean the addresses are safe.',
        intelligenceVersion: r.version, lookupMs: r.ms, chain: b.chain, matches, proxies, invalid };
    } catch (e: any) {
      return { status: 'INTELLIGENCE_UNAVAILABLE', note: 'Treat as unknown, not as safe.', intelligenceVersion: null, lookupMs: null, chain: b.chain, matches: [], proxies, invalid, error: String(e.message ?? e).slice(0, 160) };
    }
  };
  const doReport = async (orgId: string, who: { userId?: string; keyId?: string }, req: FastifyRequest) => {
    const b = body(req, reportSchema);
    if (b.agentId && !(await one(db, 'SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [b.agentId, orgId]))) throw bad('INVALID_AGENT', 'Unknown agent for this organization.');
    const r = await ingest(db, { orgId, agentId: b.agentId ?? null, userId: who.userId ?? null, keyId: who.keyId ?? null, sourceType: 'USER_REPORT', chain: b.chain, txHash: b.txHash ?? null,
      subjectType: b.subject.type, subjectValue: b.subject.value, category: b.category, evidence: b.evidence, description: b.description ?? null, observedAt: b.observedAt ? new Date(b.observedAt) : undefined, correlationId: req.id });
    req.log.info({ correlationId: req.id, observation: r.id, status: r.processingStatus }, 'network.report');
    return { ...(await reportStatus(db, orgId, r.id)), duplicate: r.duplicate };
  };

  // ---------------------------------------------------------------- agent keys
  app.get('/v1/network/indicators', async (req) => { await agentKey(req, 'network:read'); return { items: await listIndicators(db, listQuery(req.query)) }; });
  app.get('/v1/network/indicators/:id', async (req) => { await agentKey(req, 'network:read'); return indicatorDetail(db, (req.params as any).id); });
  app.post('/v1/network/lookup', async (req) => { const p = await agentKey(req, 'network:read'); return doLookup(p.orgId, body(req, lookupSchema)); });
  app.get('/v1/network/activity', async (req) => { await agentKey(req, 'network:read'); const qs = req.query as any; return { items: await activity(db, Number(qs.after) || 0, Math.min(Number(qs.limit) || 100, 500), typeof qs.chain === 'string' ? qs.chain : undefined) }; });
  app.post('/v1/network/reports', async (req, reply) => { const p = await agentKey(req, 'network:report'); const r = await doReport(p.orgId, { keyId: p.keyId }, req); reply.code(201); return r; });
  app.get('/v1/network/reports/:id', async (req) => { const p = await agentKey(req, 'network:report'); return reportStatus(db, p.orgId, (req.params as any).id); });
  app.get('/v1/network/health', async () => health(db));

  // ---------------------------------------------------------------- console session
  const O = '/v1/orgs/:orgId/network';
  app.get(`${O}/indicators`, async (req) => { await member(req); return { items: await listIndicators(db, listQuery(req.query)) }; });
  app.get(`${O}/indicators/:id`, async (req) => { await member(req); return indicatorDetail(db, (req.params as any).id); });
  app.post(`${O}/lookup`, async (req) => { const m = await member(req); return doLookup(m.orgId, body(req, lookupSchema)); });
  app.get(`${O}/activity`, async (req) => { await member(req); const qs = req.query as any; return { items: await activity(db, Number(qs.after) || 0, Math.min(Number(qs.limit) || 100, 500), typeof qs.chain === 'string' ? qs.chain : undefined) }; });
  app.get(`${O}/stats`, async (req) => { await member(req); return stats(db); });
  app.post(`${O}/reports`, async (req, reply) => {
    const m = await member(req, 'ADMIN');
    const r = await doReport(m.orgId, { userId: m.user.id }, req);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'network.report', targetType: 'observation', targetId: r.id, ip: ip(req) });
    reply.code(201); return r;
  });
  app.get(`${O}/reports`, async (req) => {
    const m = await member(req);
    const rows = await q(db, 'SELECT id FROM threat_observations WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100', [m.orgId]);
    return { items: await Promise.all(rows.map((r) => reportStatus(db, m.orgId, r.id))) };
  });
  app.get(`${O}/reports/:id`, async (req) => { const m = await member(req); return reportStatus(db, m.orgId, (req.params as any).id); });
  app.delete(`${O}/reports/:id`, async (req) => {
    const m = await member(req, 'ADMIN');
    const r = await deleteObservation(db, m.orgId, (req.params as any).id);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'network.report.delete', targetType: 'observation', targetId: r.id, ip: ip(req) });
    return r;
  });
  app.get(`${O}/subscriptions`, async (req) => { const m = await member(req); return settingsView(await settings(db, m.orgId)); });
  app.patch(`${O}/subscriptions`, async (req) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ enabled: z.boolean().optional(), minimumConfidence: z.number().int().min(0).max(100).optional(), minimumSeverity: z.enum(SEVERITIES).optional(),
      subscribedCategories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).optional(), deliveryMethod: z.enum(['webhook', 'none']).optional(), sharingMode: z.enum(SHARING).optional() }).strict());
    if (b.sharingMode !== undefined && m.role !== 'OWNER') throw forbidden('Only an owner can change what the organization shares.');
    await settings(db, m.orgId);
    await q(db, `UPDATE network_settings SET sub_enabled = COALESCE($2, sub_enabled), min_confidence = COALESCE($3, min_confidence), min_severity = COALESCE($4, min_severity),
      categories = COALESCE($5, categories), delivery = COALESCE($6, delivery), sharing_mode = COALESCE($7, sharing_mode), updated_by = $8, updated_at = now() WHERE org_id = $1`,
      [m.orgId, b.enabled ?? null, b.minimumConfidence ?? null, b.minimumSeverity ?? null, b.subscribedCategories ?? null, b.deliveryMethod ?? null, b.sharingMode ?? null, m.user.id]);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'network.subscription.update', targetType: 'organization', targetId: m.orgId, detail: b, ip: ip(req) });
    return settingsView(await settings(db, m.orgId));
  });

  // ---------------------------------------------------------------- reviewers
  const reviewer = async (req: FastifyRequest) => {
    const u = await user(req);
    const r = await isReviewer(db, u.id);
    if (!r) throw forbidden('This requires the network security reviewer role.', 'NOT_A_REVIEWER');
    return { user: u, role: r.role as string };
  };
  app.get('/v1/admin/network/me', async (req) => { const u = await user(req); const r = await isReviewer(db, u.id); return { reviewer: !!r, role: r?.role ?? null }; });
  app.get('/v1/admin/network/reviews', async (req) => {
    await reviewer(req);
    const f = listQuery(req.query);
    return { items: await listIndicators(db, { ...f, status: f.status?.length ? f.status : ['REPORTED', 'UNDER_REVIEW', 'SUSPECTED', 'DISPUTED'] }, true) };
  });
  app.get('/v1/admin/network/indicators/:id', async (req) => { await reviewer(req); return indicatorDetail(db, (req.params as any).id, true); });
  app.post('/v1/admin/network/observations', async (req, reply) => {
    const r = await reviewer(req);
    const b = body(req, reportSchema.omit({ agentId: true }));
    const o = await ingest(db, { orgId: null, userId: r.user.id, sourceType: 'ADMIN', sourceReference: `reviewer:${r.user.id}`, chain: b.chain, txHash: b.txHash ?? null, subjectType: b.subject.type, subjectValue: b.subject.value,
      category: b.category, evidence: b.evidence, description: b.description ?? null, correlationId: req.id });
    reply.code(201); return o;
  });
  const reviewSchema = z.object({ reason: z.string().trim().min(10).max(1000), evidenceRefs: z.array(z.string().max(200)).max(20).optional(), severity: z.enum(SEVERITIES).optional(),
    category: z.enum(CATEGORIES).optional(), publicSummary: z.string().trim().max(280).optional() }).strict();
  for (const [path, action] of [['review', 'review'], ['suspect', 'suspect'], ['verify', 'verify'], ['dispute', 'dispute'], ['revoke', 'revoke'], ['false-positive', 'false_positive']] as [string, ReviewAction][]) {
    app.post(`/v1/admin/network/indicators/:id/${path}`, async (req) => {
      const r = await reviewer(req);
      const b = body(req, reviewSchema);
      const out = await review(db, (req.params as any).id, r.user.id, action, b);
      req.log.info({ correlationId: req.id, indicator: out.indicator.id, action, to: out.indicator.status, pending: out.pendingSecondReview }, 'network.review');
      return { pendingSecondReview: out.pendingSecondReview, target: ACTIONS[action], indicator: indicatorView(out.indicator) };
    });
  }
}
