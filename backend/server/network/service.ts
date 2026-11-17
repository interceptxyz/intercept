/**
 * Intercept Network services inside the existing backend:
 *   ingestion (normalize, validate, deduplicate, rate-limit, on-chain check) → registry (indicator +
 *   evidence) → scoring (correlation-aware) → lifecycle transitions with reviews → transactional
 *   outbox (intelligence_events) → distribution (existing signed webhooks with retries).
 * Customer observations stay organization-scoped unless the organization's sharing mode allows
 * contribution; the shared registry only ever returns sanitized, generated summaries.
 */
import { createHash } from 'crypto';
import { Db, one, q, tx } from '../db';
import { HttpError, bad, forbidden, newId, notFound } from '../lib/util';
import { emit, attempt } from '../services/webhooks';
import { ACTIVE, CATEGORY_SEVERITY, CHAINS, Category, Chain, IndicatorType, NormalizeError, PUBLISHED, Severity, Sharing, SourceType, Status, normalizeTxHash, normalizeValue, sevRank } from './model';
import { EvidenceInput, SCORING_VERSION, confidence, shouldSuspect } from './scoring';
import { ACTIONS, EVENT_FOR, ReviewAction, TTL_DAYS, canTransition } from './lifecycle';
import { verifyTx } from './chains';
import { PROVIDERS, lookupExternal } from './providers';
import { bumpVersion } from './matching';
import { SUPPORTED } from '../solana/programs';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const RELIABILITY: Partial<Record<SourceType, number>> = { EXTERNAL: 60, ADMIN: 90, ONCHAIN: 70 };
export const REPORT_LIMITS = { perHour: Number(process.env.NETWORK_REPORTS_PER_HOUR ?? 30), perDay: Number(process.env.NETWORK_REPORTS_PER_DAY ?? 200) };

// ------------------------------------------------------------------------------ settings

export async function settings(db: Db, orgId: string) {
  await q(db, 'INSERT INTO network_settings(org_id) VALUES ($1) ON CONFLICT DO NOTHING', [orgId]);
  return (await one(db, 'SELECT * FROM network_settings WHERE org_id = $1', [orgId]))!;
}
export const settingsView = (s: any) => ({
  sharingMode: s.sharing_mode as Sharing, enabled: s.sub_enabled, minimumConfidence: s.min_confidence, minimumSeverity: s.min_severity,
  subscribedCategories: s.categories, deliveryMethod: s.delivery, updatedAt: s.updated_at,
});

// ------------------------------------------------------------------------------ ingestion

export interface Observation {
  orgId: string | null; agentId?: string | null; userId?: string | null; keyId?: string | null;
  sourceType: SourceType; sourceReference?: string | null; chain: Chain; txHash?: string | null;
  subjectType: IndicatorType; subjectValue: string; category: Category; evidence?: Record<string, unknown>; description?: string | null;
  observedAt?: Date; reliability?: number; dedupScope?: string; correlationId?: string | null;
}

export async function ingest(db: Db, o: Observation) {
  let value: string, txHash: string | null = null;
  try {
    value = normalizeValue(o.chain, o.subjectType, o.subjectValue);
    if (o.txHash) txHash = normalizeTxHash(o.chain, o.txHash);
  } catch (e) { if (e instanceof NormalizeError) throw bad('INVALID_SUBJECT', `Invalid value for ${CHAINS[o.chain].family} chain ${o.chain}: ${e.message}.`); throw e; }
  // core infrastructure cannot be reported (poisoning it would disrupt every participant)
  if (CHAINS[o.chain].family === 'base58' && SUPPORTED.has(value)) throw bad('PROTECTED_SUBJECT', 'Core infrastructure programs cannot be reported as threats.');
  const evidence = o.evidence ?? {};
  if (JSON.stringify(evidence).length > 8_000) throw bad('EVIDENCE_TOO_LARGE', 'Evidence is limited to 8 KB.');

  // contribution limits (user reports)
  if (o.sourceType === 'USER_REPORT' && o.orgId) {
    const n = await one(db, `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int h, count(*)::int d FROM threat_observations
      WHERE org_id = $1 AND source_type = 'USER_REPORT' AND created_at > now() - interval '24 hours'`, [o.orgId]);
    if (n!.h >= REPORT_LIMITS.perHour || n!.d >= REPORT_LIMITS.perDay) throw new HttpError(429, 'REPORT_LIMIT', `Report limit reached (${REPORT_LIMITS.perHour}/hour, ${REPORT_LIMITS.perDay}/day per organization).`);
  }

  const st = o.orgId ? await settings(db, o.orgId) : null;
  const visibility = !o.orgId ? 'PUBLIC' : st!.sharing_mode === 'PRIVATE' ? 'PRIVATE' : st!.sharing_mode === 'ANONYMIZED_INTELLIGENCE' ? 'ANONYMIZED' : 'AUTHORIZED';
  const source = o.orgId ? `org:${o.orgId}` : o.sourceType === 'EXTERNAL' ? `provider:${o.sourceReference}` : o.userId ? `user:${o.userId}` : `system:${o.sourceType}`;
  const dedupKey = sha([source, o.dedupScope ?? '', o.chain, o.subjectType, value, o.category, txHash ?? '', o.sourceType].join('|'));

  const dup = await one(db, 'SELECT id, indicator_id, processing_status FROM threat_observations WHERE dedup_key = $1', [dedupKey]);
  if (dup) {
    if (dup.indicator_id) await q(db, 'UPDATE threat_indicators SET observation_count = observation_count + 1, last_seen_at = now() WHERE id = $1', [dup.indicator_id]);
    return { id: dup.id, duplicate: true, processingStatus: 'DUPLICATE', indicatorId: dup.indicator_id as string | null, evidence: null };
  }

  // evidence validation: the referenced transaction must exist and involve the subject
  let verification: 'UNVERIFIED' | 'VERIFIED_ONCHAIN' | 'REJECTED' = 'UNVERIFIED', txCheck: any = null;
  if (txHash) {
    try {
      txCheck = await verifyTx(o.chain, txHash, value);
      verification = txCheck.found && txCheck.involvesSubject && txCheck.status !== 'PENDING' ? 'VERIFIED_ONCHAIN' : txCheck.status === 'PENDING' ? 'UNVERIFIED' : 'REJECTED';
    } catch (e: any) { txCheck = { error: String(e.message ?? e).slice(0, 160) }; }
  }
  const rejected = verification === 'REJECTED' && o.sourceType === 'USER_REPORT' && !Object.keys(evidence).length && !o.description;

  const obsId = newId('obs');
  const result = await tx(async (c) => {
    const processing = rejected ? 'REJECTED' : visibility === 'PRIVATE' ? 'PRIVATE' : 'ACCEPTED';
    await c.query(`INSERT INTO threat_observations(id, org_id, agent_id, reporter_user_id, reporter_key_id, source_type, source_reference, chain, tx_hash, subject_type, subject_value, category,
        evidence, description, correlation_key, observed_at, dedup_key, processing_status, rejection_reason, visibility, correlation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [obsId, o.orgId, o.agentId ?? null, o.userId ?? null, o.keyId ?? null, o.sourceType, o.sourceReference ?? null, o.chain, txHash, o.subjectType, value, o.category,
        JSON.stringify({ ...evidence, ...(txCheck ? { onchain: txCheck } : {}) }), o.description ?? null, source, o.observedAt ?? new Date(), dedupKey, processing,
        rejected ? 'The referenced transaction does not exist or does not involve the subject, and no other evidence was given.' : null, visibility, o.correlationId ?? null]);
    if (processing !== 'ACCEPTED') return { processing, indicatorId: null };

    // indicator: one per (chain, type, value)
    const testnet = CHAINS[o.chain].testnet;
    await c.query(`INSERT INTO threat_indicators(id, chain, testnet, indicator_type, value, category, severity, scoring_version, status, first_seen_at, last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REPORTED',now(),now()) ON CONFLICT (chain, indicator_type, value) DO NOTHING`,
      [newId('ind'), o.chain, testnet, o.subjectType, value, o.category, CATEGORY_SEVERITY[o.category], SCORING_VERSION]);
    const ind = await one(c, 'SELECT * FROM threat_indicators WHERE chain = $1 AND indicator_type = $2 AND value = $3 FOR UPDATE', [o.chain, o.subjectType, value]);
    await c.query('UPDATE threat_observations SET indicator_id = $2 WHERE id = $1', [obsId, ind.id]);
    const shareRef = visibility === 'AUTHORIZED' || visibility === 'PUBLIC';
    await c.query(`INSERT INTO threat_evidence(id, indicator_id, observation_id, evidence_type, evidence_reference, evidence_hash, summary, source_reliability, verification_status, visibility)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [newId('evd'), ind.id, obsId, o.sourceType, shareRef ? txHash : null, sha(JSON.stringify(evidence) + (txHash ?? '')), summaryFor(o.sourceType, o.category, verification, txCheck),
        o.reliability ?? (o.orgId ? st!.reliability : RELIABILITY[o.sourceType] ?? 50), verification, shareRef || visibility === 'ANONYMIZED' ? 'SHAREABLE' : 'INTERNAL']);
    await c.query('UPDATE threat_indicators SET observation_count = observation_count + 1, last_seen_at = now(), updated_at = now() WHERE id = $1', [ind.id]);
    await rescore(c, ind.id);
    return { processing, indicatorId: ind.id as string };
  });
  if (result.indicatorId) {
    void dispatchPending(db).catch(() => undefined);
    // external corroboration for chains a provider covers (evidence only, internal)
    if (o.sourceType !== 'EXTERNAL' && (o.subjectType === 'ADDRESS' || o.subjectType === 'CONTRACT')) void enrich(db, o.chain, o.subjectType, value).catch(() => undefined);
  }
  return { id: obsId, duplicate: false, processingStatus: result.processing, indicatorId: result.indicatorId, evidence: { verification, onchain: txCheck } };
}

function summaryFor(src: SourceType, cat: Category, v: string, txCheck: any) {
  const what = cat.toLowerCase().replace(/_/g, ' ');
  const s = { FIREWALL: 'Flagged by a transaction firewall check', SIMULATION: 'Flagged by a transaction simulation', AGENT_MONITORING: 'Flagged by agent activity monitoring', USER_REPORT: 'Reported by a participant',
    EXTERNAL: 'Flagged by an external intelligence provider', ADMIN: 'Recorded by an Intercept security investigation', ONCHAIN: 'Derived from public on-chain evidence' }[src];
  return `${s} as ${what}${v === 'VERIFIED_ONCHAIN' ? `; referenced transaction verified on chain (${String(txCheck?.status).toLowerCase()})` : v === 'REJECTED' ? '; referenced transaction did not validate' : ''}.`;
}

export async function enrich(db: Db, chain: Chain, type: IndicatorType, value: string) {
  for (const p of PROVIDERS) {
    const r = await lookupExternal(db, p, chain, value);
    if (r?.flagged) await ingest(db, { orgId: null, sourceType: 'EXTERNAL', sourceReference: p.name, chain, subjectType: type, subjectValue: value, category: r.categories[0] ?? 'SUSPICIOUS_PATTERN', evidence: { signals: r.signals, source: r.source } });
  }
}

/** Independent sources: union of sources that share an underlying incident (same transaction). */
export function independentClusters(rows: { source: string; tx: string | null }[]) {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };
  for (const r of rows) { if (!parent.has(r.source)) parent.set(r.source, r.source); if (r.tx) { const t = 'tx:' + r.tx; if (!parent.has(t)) parent.set(t, t); union(r.source, t); } }
  return new Map(rows.map((r) => [r.source, find(r.source)]));
}

async function rescore(c: Db, indicatorId: string, opt: { promote: boolean } = { promote: true }) {
  const ind = await one(c, 'SELECT * FROM threat_indicators WHERE id = $1', [indicatorId]);
  const rows = await q(c, `SELECT o.correlation_key source, o.tx_hash, o.source_type, e.verification_status, e.source_reliability FROM threat_evidence e JOIN threat_observations o ON o.id = e.observation_id WHERE e.indicator_id = $1`, [indicatorId]);
  const clusters = independentClusters(rows.map((r) => ({ source: r.source, tx: r.tx_hash })));
  const ev: EvidenceInput[] = rows.map((r) => ({ sourceType: r.source_type, cluster: clusters.get(r.source)!, verification: r.verification_status, reliability: r.source_reliability }));
  const reviews = await q(c, 'SELECT review_type, reviewer_id FROM threat_reviews WHERE indicator_id = $1', [indicatorId]);
  const { score, factors } = confidence(ev, reviews.map((r) => ({ type: r.review_type, reviewerId: r.reviewer_id })), new Date(ind.last_seen_at));
  const independent = new Set(ev.filter((e) => e.verification !== 'REJECTED').map((e) => e.cluster)).size;
  await c.query('UPDATE threat_indicators SET confidence = $2, confidence_explanation = $3, independent_source_count = $4, scoring_version = $5, updated_at = now() WHERE id = $1',
    [indicatorId, score, JSON.stringify(factors), independent, SCORING_VERSION]);
  if (!opt.promote) return { score, independent };
  // system promotion: never beyond SUSPECTED
  if ((ind.status === 'REPORTED' || ind.status === 'EXPIRED') && shouldSuspect(score, independent)) {
    await move(c, ind, 'SUSPECTED', { reviewerId: null, type: 'system', reason: `${independent} independent sources, confidence ${score} (${SCORING_VERSION})` });
  } else if (ACTIVE.includes(ind.status) && (Math.abs(score - ind.confidence) >= 5 || independent !== ind.independent_source_count)) {
    await publish(c, { ...ind, confidence: score, independent_source_count: independent }, 'threat.updated');
  }
  return { score, independent };
}

// ------------------------------------------------------------------------------ lifecycle

async function move(c: Db, ind: any, to: Status, r: { reviewerId: string | null; type: string; reason: string; evidenceRefs?: string[]; severity?: Severity; category?: Category; publicSummary?: string }) {
  if (!canTransition(ind.status, to)) throw new HttpError(409, 'INVALID_TRANSITION', `An indicator cannot go from ${ind.status} to ${to}.`);
  await c.query('INSERT INTO threat_reviews(id, indicator_id, reviewer_id, review_type, previous_status, new_status, reason, evidence_refs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [newId('rev'), ind.id, r.reviewerId, r.type, ind.status, to, r.reason, JSON.stringify(r.evidenceRefs ?? [])]);
  const ttl = TTL_DAYS[to];
  await c.query(`UPDATE threat_indicators SET status = $2, verified_at = CASE WHEN $2 = 'VERIFIED' THEN now() ELSE verified_at END,
      expires_at = CASE WHEN $3::int IS NULL THEN expires_at ELSE now() + ($3::int || ' days')::interval END,
      severity = COALESCE($4, severity), category = COALESCE($5, category), public_summary = COALESCE($6, public_summary), revision = revision + 1, updated_at = now() WHERE id = $1`,
    [ind.id, to, ttl ?? null, r.severity ?? null, r.category ?? null, r.publicSummary ?? null]);
  await rescore(c, ind.id, { promote: false });
  const next = await one(c, 'SELECT * FROM threat_indicators WHERE id = $1', [ind.id]);
  // source reliability follows outcomes (contributing organizations only)
  if (to === 'VERIFIED' || to === 'FALSE_POSITIVE') {
    const d = to === 'VERIFIED' ? 5 : -15;
    await c.query(`UPDATE network_settings SET reliability = LEAST(90, GREATEST(5, reliability + $2)) WHERE org_id IN (SELECT DISTINCT org_id FROM threat_observations WHERE indicator_id = $1 AND org_id IS NOT NULL)`, [ind.id, d]);
  }
  // anything that enters, leaves or changes the shared registry is published (corrections included)
  const ev = PUBLISHED.includes(to) ? EVENT_FOR[to] ?? 'threat.updated' : PUBLISHED.includes(ind.status) ? 'threat.updated' : null;
  if (ev) await publish(c, next, ev);
  return next;
}

/** Sanitized event payload: indicator facts and the generated summary, never sources or customers. */
export const eventPayload = (i: any) => ({
  indicatorId: i.id, chain: i.chain, testnet: i.testnet, indicatorType: i.indicator_type, value: i.value, category: i.category, severity: i.severity,
  confidence: i.confidence, status: i.status, publicSummary: publicSummary(i), expiresAt: i.expires_at,
});
async function publish(c: Db, ind: any, type: string) {
  const id = newId('evt');
  const payload = eventPayload(ind);
  const r = await one(c, 'INSERT INTO intelligence_events(id, event_type, indicator_id, chain, payload) VALUES ($1,$2,$3,$4,$5) RETURNING sequence_number', [id, type, ind.id, ind.chain, JSON.stringify(payload)]);
  await c.query('UPDATE threat_indicators SET intelligence_version = $2 WHERE id = $1', [ind.id, r!.sequence_number]);
  bumpVersion(Number(r!.sequence_number));
  return Number(r!.sequence_number);
}

export function publicSummary(i: any) {
  if (i.public_summary) return i.public_summary;
  const what = String(i.category).toLowerCase().replace(/_/g, ' ');
  return `${i.status === 'VERIFIED' ? 'Verified' : i.status === 'SUSPECTED' ? 'Suspected' : String(i.status).toLowerCase().replace('_', ' ')} ${what}: ${i.independent_source_count} independent source(s), confidence ${i.confidence}/100.`;
}

export async function isReviewer(db: Db, userId: string) { return one(db, 'SELECT role FROM network_reviewers WHERE user_id = $1', [userId]); }

export interface ReviewInput { reason: string; evidenceRefs?: string[]; severity?: Severity; category?: Category; publicSummary?: string }
/** Reviewer action. HIGH/CRITICAL verifications need two different reviewers; reporters cannot verify their own reports. */
export async function review(db: Db, indicatorId: string, reviewerId: string, action: ReviewAction, input: ReviewInput) {
  if (!(await isReviewer(db, reviewerId))) throw forbidden('This requires the network security reviewer role.', 'NOT_A_REVIEWER');
  const target = ACTIONS[action] as Status;
  if (action === 'verify') await reverifyOnchain(db, indicatorId); // reorgs: evidence must still hold
  const out = await tx(async (c) => {
    const ind = await one(c, 'SELECT * FROM threat_indicators WHERE id = $1 FOR UPDATE', [indicatorId]);
    if (!ind) throw notFound('Indicator');
    if (action === 'verify') {
      const own = await one(c, 'SELECT 1 FROM threat_observations WHERE indicator_id = $1 AND reporter_user_id = $2 LIMIT 1', [indicatorId, reviewerId]);
      if (own) throw forbidden('You reported this indicator: another reviewer must verify it.', 'CONFLICT_OF_INTEREST');
      const severity = input.severity ?? ind.severity;
      if (sevRank(severity) >= sevRank('HIGH')) {
        const since = await one(c, `SELECT max(created_at) t FROM threat_reviews WHERE indicator_id = $1 AND review_type <> 'verify_approval'`, [indicatorId]);
        const first = await one(c, `SELECT reviewer_id FROM threat_reviews WHERE indicator_id = $1 AND review_type = 'verify_approval' AND created_at >= COALESCE($2, '-infinity'::timestamptz) ORDER BY created_at DESC LIMIT 1`, [indicatorId, since?.t ?? null]);
        if (!first || first.reviewer_id === reviewerId) {
          if (first?.reviewer_id === reviewerId) throw new HttpError(409, 'SECOND_REVIEWER_REQUIRED', 'You already approved this verification: a different reviewer must confirm it.');
          // first approval: recorded, status unchanged (or moved to UNDER_REVIEW)
          const to = ind.status === 'UNDER_REVIEW' ? 'UNDER_REVIEW' : canTransition(ind.status, 'UNDER_REVIEW') ? 'UNDER_REVIEW' : ind.status;
          await c.query('INSERT INTO threat_reviews(id, indicator_id, reviewer_id, review_type, previous_status, new_status, reason, evidence_refs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [newId('rev'), indicatorId, reviewerId, 'verify_approval', ind.status, to, input.reason, JSON.stringify(input.evidenceRefs ?? [])]);
          if (to !== ind.status) await c.query(`UPDATE threat_indicators SET status = $2, revision = revision + 1, updated_at = now() WHERE id = $1`, [indicatorId, to]);
          return { pendingSecondReview: true, indicator: await one(c, 'SELECT * FROM threat_indicators WHERE id = $1', [indicatorId]) };
        }
      }
    }
    const next = await move(c, ind, target, { reviewerId, type: action, ...input });
    return { pendingSecondReview: false, indicator: await one(c, 'SELECT * FROM threat_indicators WHERE id = $1', [next.id]) };
  });
  await dispatchPending(db).catch(() => undefined);
  return out;
}

async function reverifyOnchain(db: Db, indicatorId: string) {
  const rows = await q(db, `SELECT e.id, o.chain, o.tx_hash, o.subject_value FROM threat_evidence e JOIN threat_observations o ON o.id = e.observation_id WHERE e.indicator_id = $1 AND e.verification_status = 'VERIFIED_ONCHAIN' AND o.tx_hash IS NOT NULL`, [indicatorId]);
  for (const r of rows) {
    const v = await verifyTx(r.chain, r.tx_hash, r.subject_value).catch(() => null);
    if (v && (!v.found || !v.involvesSubject)) await q(db, `UPDATE threat_evidence SET verification_status = 'REJECTED', summary = summary || ' Re-check failed (transaction no longer found: reorganization or invalid reference).' WHERE id = $1`, [r.id]);
  }
}

/** Active indicators past their lifetime expire (they can be re-confirmed by new evidence or a reviewer). */
export async function expireDue(db: Db) {
  const due = await q(db, `SELECT id FROM threat_indicators WHERE status IN ('SUSPECTED','VERIFIED') AND expires_at < now() LIMIT 50`);
  for (const d of due) await tx(async (c) => { const ind = await one(c, 'SELECT * FROM threat_indicators WHERE id = $1 FOR UPDATE', [d.id]); if (ind && ACTIVE.includes(ind.status) && new Date(ind.expires_at) < new Date()) await move(c, ind, 'EXPIRED', { reviewerId: null, type: 'system', reason: 'lifetime elapsed without re-confirmation' }); });
  return due.length;
}

// ------------------------------------------------------------------------------ distribution

const CORRECTIONS = ['threat.revoked', 'threat.false_positive', 'threat.expired', 'threat.disputed'];
/**
 * Outbox relay: each event is fanned out once (row in intelligence_dispatch, same transaction) to the
 * organizations whose subscription matches, through their signed webhooks (retries, backoff, logs,
 * redelivery). Corrections ignore the confidence/severity thresholds so they reach every subscriber.
 */
export async function dispatchPending(db: Db, limit = 20) {
  const deliveries: string[] = [];
  const n = await tx(async (c) => {
    const evs = await q(c, `SELECT e.* FROM intelligence_events e LEFT JOIN intelligence_dispatch d ON d.sequence_number = e.sequence_number
      WHERE d.sequence_number IS NULL ORDER BY e.sequence_number LIMIT $1 FOR UPDATE OF e SKIP LOCKED`, [limit]);
    for (const e of evs) {
      const p = e.payload;
      const correction = CORRECTIONS.includes(e.event_type);
      // organizations with a webhook for this event type; defaults apply when no settings row exists
      const subs = await q(c, `SELECT DISTINCT w.org_id FROM webhooks w LEFT JOIN network_settings s ON s.org_id = w.org_id
        WHERE w.disabled_at IS NULL AND $5 = ANY(w.events) AND COALESCE(s.sub_enabled, true) AND COALESCE(s.delivery, 'webhook') = 'webhook'
        AND (COALESCE(cardinality(s.categories), 0) = 0 OR $1 = ANY(s.categories))
        AND ($2 OR (COALESCE(s.min_confidence, 50) <= $3 AND array_position(ARRAY['INFORMATIONAL','LOW','MEDIUM','HIGH','CRITICAL'], COALESCE(s.min_severity, 'MEDIUM')) <= array_position(ARRAY['INFORMATIONAL','LOW','MEDIUM','HIGH','CRITICAL'], $4::text)))`,
        [p.category, correction, p.confidence, p.severity, e.event_type]);
      let count = 0;
      for (const s of subs) {
        const ids = await emit(c, s.org_id, e.event_type as any, { eventId: e.id, intelligenceVersion: Number(e.sequence_number), ...p });
        deliveries.push(...ids); count += ids.length;
      }
      await c.query('INSERT INTO intelligence_dispatch(sequence_number, deliveries) VALUES ($1,$2)', [e.sequence_number, count]);
    }
    return evs.length;
  });
  for (const d of deliveries) await attempt(db, d).catch(() => undefined);
  return n;
}

export async function networkTick(db: Db) {
  const claim = await one(db, `INSERT INTO kv_state(key, value, updated_at) VALUES ('network_tick', '', now())
    ON CONFLICT (key) DO UPDATE SET updated_at = now() WHERE kv_state.updated_at < now() - interval '30 seconds' RETURNING key`);
  if (!claim) return null;
  const expired = await expireDue(db);
  const dispatched = await dispatchPending(db, 50);
  // retention: raw customer evidence and reporter text are dropped after 180 days (summaries remain)
  await q(db, `UPDATE threat_observations SET evidence = '{}', description = NULL WHERE created_at < now() - interval '180 days' AND (evidence <> '{}' OR description IS NOT NULL)`);
  return { expired, dispatched };
}

// ------------------------------------------------------------------------------ registry views

export function indicatorView(i: any) {
  return {
    id: i.id, chain: i.chain, testnet: i.testnet, indicatorType: i.indicator_type, value: i.value, category: i.category, severity: i.severity,
    confidence: i.confidence, confidenceExplanation: { scoringVersion: i.scoring_version, factors: i.confidence_explanation, note: 'Points score of the evidence, not a calibrated probability.' },
    status: i.status, firstSeenAt: i.first_seen_at, lastSeenAt: i.last_seen_at, verifiedAt: i.verified_at, expiresAt: i.expires_at,
    observationCount: i.observation_count, independentSourceCount: i.independent_source_count, publicSummary: publicSummary(i), intelligenceVersion: Number(i.intelligence_version), updatedAt: i.updated_at,
  };
}

export async function listIndicators(db: Db, f: { chain?: string; type?: string; category?: string; minSeverity?: string; minConfidence?: number; status?: string[]; value?: string; updatedSince?: string; before?: string; limit: number }, internal = false) {
  const p: unknown[] = []; const w: string[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace('?', `$${p.length}`)); };
  const statuses = (f.status?.length ? f.status : ACTIVE).filter((s) => internal || PUBLISHED.includes(s as Status));
  add('status = ANY(?)', statuses);
  if (f.chain) add('chain = ?', f.chain);
  if (f.type) add('indicator_type = ?', f.type);
  if (f.category) add('category = ?', f.category);
  if (f.minConfidence !== undefined) add('confidence >= ?', f.minConfidence);
  if (f.minSeverity) add(`array_position(ARRAY['INFORMATIONAL','LOW','MEDIUM','HIGH','CRITICAL'], severity) >= array_position(ARRAY['INFORMATIONAL','LOW','MEDIUM','HIGH','CRITICAL'], ?::text)`, f.minSeverity);
  if (f.value) add('value = ?', f.value);
  if (f.updatedSince) add('updated_at > ?', f.updatedSince);
  if (f.before) add('updated_at < ?', f.before);
  p.push(f.limit);
  const rows = await q(db, `SELECT * FROM threat_indicators WHERE ${w.join(' AND ')} ORDER BY updated_at DESC LIMIT $${p.length}`, p);
  return rows.map(indicatorView);
}

export async function indicatorDetail(db: Db, id: string, internal = false) {
  const i = await one(db, 'SELECT * FROM threat_indicators WHERE id = $1', [id]);
  if (!i || (!internal && !PUBLISHED.includes(i.status))) throw notFound('Indicator');
  const evidence = await q(db, `SELECT e.*, o.org_id, o.source_type, o.description, o.evidence raw, o.reporter_user_id FROM threat_evidence e LEFT JOIN threat_observations o ON o.id = e.observation_id WHERE e.indicator_id = $1 ${internal ? '' : `AND e.visibility = 'SHAREABLE'`} ORDER BY e.created_at`, [id]);
  const history = await q(db, 'SELECT * FROM threat_reviews WHERE indicator_id = $1 ORDER BY created_at', [id]);
  const events = await q(db, 'SELECT sequence_number, id, event_type, published_at FROM intelligence_events WHERE indicator_id = $1 ORDER BY sequence_number', [id]);
  return {
    ...indicatorView(i),
    evidence: evidence.map((e) => ({ id: e.id, type: e.evidence_type, summary: e.summary, reference: e.evidence_reference, verification: e.verification_status, createdAt: e.created_at,
      ...(internal ? { sourceReliability: e.source_reliability, organizationId: e.org_id, reporterUserId: e.reporter_user_id, description: e.description, raw: e.raw, visibility: e.visibility } : {}) })),
    history: history.map((h) => ({ at: h.created_at, from: h.previous_status, to: h.new_status, type: h.review_type, ...(internal ? { reviewerId: h.reviewer_id, reason: h.reason, evidenceRefs: h.evidence_refs } : {}) })),
    versions: events.map((e) => ({ intelligenceVersion: Number(e.sequence_number), eventId: e.id, type: e.event_type, publishedAt: e.published_at })),
  };
}

export async function activity(db: Db, after: number, limit: number, chain?: string) {
  const rows = await q(db, `SELECT * FROM intelligence_events WHERE sequence_number > $1 ${chain ? 'AND chain = $3' : ''} ORDER BY sequence_number LIMIT $2`, chain ? [after, limit, chain] : [after, limit]);
  return rows.map((e) => ({ eventId: e.id, type: e.event_type, intelligenceVersion: Number(e.sequence_number), publishedAt: e.published_at, data: e.payload }));
}

/** Organization-scoped report status. Another organization's report reads as not found. */
export async function reportStatus(db: Db, orgId: string, id: string) {
  const o = await one(db, 'SELECT * FROM threat_observations WHERE id = $1 AND org_id = $2', [id, orgId]);
  if (!o) throw notFound('Report');
  const i = o.indicator_id ? await one(db, 'SELECT * FROM threat_indicators WHERE id = $1', [o.indicator_id]) : null;
  return { id: o.id, sourceType: o.source_type, chain: o.chain, subject: { type: o.subject_type, value: o.subject_value }, category: o.category, txHash: o.tx_hash,
    processingStatus: o.processing_status, rejectionReason: o.rejection_reason, visibility: o.visibility, createdAt: o.created_at,
    evidenceCheck: o.evidence?.onchain ?? null, indicator: i ? { id: i.id, status: i.status, confidence: i.confidence, published: PUBLISHED.includes(i.status) } : null };
}

/** Deletion workflow: an organization removes one of its observations; scores are recomputed. */
export async function deleteObservation(db: Db, orgId: string, id: string) {
  return tx(async (c) => {
    const o = await one(c, 'SELECT * FROM threat_observations WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, orgId]);
    if (!o) throw notFound('Report');
    await c.query('DELETE FROM threat_evidence WHERE observation_id = $1', [id]);
    await c.query('DELETE FROM threat_observations WHERE id = $1', [id]);
    if (o.indicator_id) { await c.query('SELECT 1 FROM threat_indicators WHERE id = $1 FOR UPDATE', [o.indicator_id]); await rescore(c, o.indicator_id, { promote: false }); }
    return { id, deleted: true };
  });
}
