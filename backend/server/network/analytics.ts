/**
 * Network analytics: counts read from the registry and match tables, nothing estimated. Counts that
 * could single out participants (fewer than K organizations) are withheld. No "funds saved" figure:
 * a blocked transaction's value is not money saved.
 */
import { Db, one, q } from '../db';
import { cacheStats } from './matching';
import { providerHealth } from './providers';

const K = Number(process.env.NETWORK_MIN_COHORT ?? 3);
const k = (n: number) => (n >= K ? n : null);

export async function stats(db: Db) {
  const [ind, ev, m, orgs, agents, lat, turn, cats, backlog] = await Promise.all([
    one(db, `SELECT count(*) FILTER (WHERE status = 'VERIFIED')::int verified, count(*) FILTER (WHERE status = 'SUSPECTED')::int suspected,
      count(*) FILTER (WHERE status IN ('SUSPECTED','VERIFIED') AND first_seen_at > now() - interval '7 days')::int new7d FROM threat_indicators WHERE NOT testnet`),
    one(db, `SELECT count(*) FILTER (WHERE event_type = 'threat.revoked')::int revoked, count(*) FILTER (WHERE event_type = 'threat.false_positive')::int false_positive,
      count(*) FILTER (WHERE event_type = 'threat.verified')::int verified FROM intelligence_events WHERE published_at > now() - interval '30 days'`),
    one(db, `SELECT count(*)::int n, count(DISTINCT org_id)::int orgs FROM threat_matches WHERE created_at > now() - interval '7 days'`),
    one(db, `SELECT count(DISTINCT w.org_id)::int n FROM webhooks w LEFT JOIN network_settings s ON s.org_id = w.org_id WHERE w.disabled_at IS NULL AND COALESCE(s.sub_enabled, true) AND w.events && ARRAY['threat.verified','threat.reported','threat.revoked']`),
    one(db, `SELECT count(*)::int n FROM agents a WHERE a.status = 'ACTIVE' AND a.org_id IN (SELECT w.org_id FROM webhooks w WHERE w.disabled_at IS NULL AND w.events && ARRAY['threat.verified','threat.reported','threat.revoked'])`),
    one(db, `SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY (intelligence->>'lookupMs')::int) p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY (intelligence->>'lookupMs')::int) p95
      FROM evaluations WHERE created_at > now() - interval '24 hours' AND intelligence->>'lookupMs' IS NOT NULL`),
    one(db, `SELECT avg(extract(epoch FROM verified_at - first_seen_at))::int secs FROM threat_indicators WHERE verified_at > now() - interval '30 days'`),
    q(db, `SELECT category, count(*)::int n FROM threat_indicators WHERE status IN ('SUSPECTED','VERIFIED') AND NOT testnet GROUP BY 1 ORDER BY 2 DESC`),
    one(db, `SELECT count(*)::int n, EXTRACT(epoch FROM now() - min(e.published_at))::int oldest FROM intelligence_events e LEFT JOIN intelligence_dispatch d USING (sequence_number) WHERE d.sequence_number IS NULL`),
  ]);
  return {
    scope: 'mainnet indicators; testnet excluded', generatedAt: new Date().toISOString(), minimumCohort: K,
    indicators: { verified: ind!.verified, suspected: ind!.suspected, newLast7Days: ind!.new7d },
    last30Days: { verified: ev!.verified, revoked: ev!.revoked, falsePositives: ev!.false_positive },
    matchesLast7Days: m!.orgs >= K ? m!.n : null,
    connectedOrganizations: k(orgs!.n), activeAgentsInConnectedOrganizations: orgs!.n >= K ? agents!.n : null,
    lookupLatencyMs: { p50: lat?.p50 ?? null, p95: lat?.p95 ?? null, cache: { ...cacheStats } },
    verificationTurnaroundSeconds: turn?.secs ?? null,
    categories: cats, distribution: { undispatchedEvents: backlog!.n, oldestUndispatchedSeconds: backlog!.oldest },
    providers: providerHealth(),
    notes: ['Counts withheld (null) when fewer organizations than the minimum cohort contribute.', 'No prevented-loss estimate is published: a blocked transaction value is not funds saved.'],
  };
}

export async function health(db: Db) {
  const t0 = Date.now();
  const v = await one(db, `SELECT COALESCE(max(sequence_number),0)::bigint v, max(published_at) last FROM intelligence_events`);
  const b = await one(db, `SELECT count(*)::int n, EXTRACT(epoch FROM now() - min(e.published_at))::int oldest FROM intelligence_events e LEFT JOIN intelligence_dispatch d USING (sequence_number) WHERE d.sequence_number IS NULL`);
  const backlogAlert = b!.n > 100 || (b!.oldest ?? 0) > 600;
  return { ok: !backlogAlert, dbMs: Date.now() - t0, intelligenceVersion: Number(v!.v), lastPublishedAt: v!.last, distribution: { backlog: b!.n, oldestSeconds: b!.oldest, alert: backlogAlert }, providers: providerHealth() };
}
