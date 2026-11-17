/**
 * Confidence and severity (pure, versioned). Confidence is a transparent points score (0-100) of how
 * strongly the evidence supports the classification; it is NOT a calibrated probability. The number
 * of reports is not a factor: only independent sources (distinct organizations / incidents) count.
 */
import { CATEGORY_SEVERITY, Category, Severity } from './model';

export const SCORING_VERSION = 'confidence-v1';

export interface EvidenceInput {
  sourceType: 'FIREWALL' | 'SIMULATION' | 'AGENT_MONITORING' | 'USER_REPORT' | 'EXTERNAL' | 'ADMIN' | 'ONCHAIN';
  /** independence cluster: organization, reviewer or provider; plus the underlying incident */
  cluster: string;
  verification: 'UNVERIFIED' | 'VERIFIED_ONCHAIN' | 'REJECTED';
  reliability: number; // 0-100 source reliability
}
export interface ReviewInput { type: string; reviewerId: string | null }
export interface Factor { factor: string; points: number; detail: string }

const BASE: Record<EvidenceInput['sourceType'], number> = { USER_REPORT: 10, AGENT_MONITORING: 12, FIREWALL: 15, SIMULATION: 15, EXTERNAL: 15, ONCHAIN: 20, ADMIN: 30 };

export function confidence(ev: EvidenceInput[], reviews: ReviewInput[], lastSeenAt: Date, now = new Date()): { score: number; factors: Factor[] } {
  const f: Factor[] = [];
  const usable = ev.filter((e) => e.verification !== 'REJECTED');
  const rejected = ev.length - usable.length;
  // best evidence per independent cluster, weighted by the source's reliability (50 = neutral)
  const best = new Map<string, number>();
  for (const e of usable) {
    const pts = (BASE[e.sourceType] + (e.verification === 'VERIFIED_ONCHAIN' ? 15 : 0)) * Math.max(0.2, Math.min(1.6, e.reliability / 50));
    best.set(e.cluster, Math.max(best.get(e.cluster) ?? 0, pts));
  }
  const ranked = [...best.values()].sort((a, b) => b - a);
  if (ranked.length) f.push({ factor: 'evidence_quality', points: Math.round(ranked[0]), detail: `Strongest evidence, weighted by source reliability.` });
  // independent corroboration: diminishing, capped; repeated reports from one cluster add nothing
  const extra = ranked.slice(1, 4).reduce((s, p, i) => s + p * [0.6, 0.4, 0.25][i], 0);
  if (ranked.length > 1) f.push({ factor: 'independent_corroboration', points: Math.round(Math.min(30, extra)), detail: `${ranked.length} independent sources (repeated reports from one source are not counted).` });
  const onchain = usable.some((e) => e.verification === 'VERIFIED_ONCHAIN');
  if (onchain) f.push({ factor: 'onchain_evidence', points: 10, detail: 'At least one referenced transaction was verified on chain and involves the subject.' });
  if (rejected) f.push({ factor: 'invalid_evidence', points: -5 * Math.min(rejected, 4), detail: `${rejected} piece(s) of evidence failed validation.` });
  // manual review
  const verifiers = new Set(reviews.filter((r) => r.type === 'verify' && r.reviewerId).map((r) => r.reviewerId));
  if (verifiers.size) f.push({ factor: 'manual_review', points: Math.min(45, 30 * verifiers.size), detail: `Verified by ${verifiers.size} security reviewer(s).` });
  const disputes = reviews.filter((r) => r.type === 'dispute').length;
  if (disputes) f.push({ factor: 'conflicting_evidence', points: -20 * Math.min(disputes, 3), detail: `${disputes} dispute(s) recorded.` });
  if (reviews.some((r) => r.type === 'false_positive')) f.push({ factor: 'false_positive_history', points: -30, detail: 'Previously classified as a false positive.' });
  // recency
  const days = (now.getTime() - lastSeenAt.getTime()) / 86_400_000;
  if (days > 180) f.push({ factor: 'recency', points: -20, detail: `Last observed ${Math.floor(days)} days ago.` });
  else if (days > 90) f.push({ factor: 'recency', points: -10, detail: `Last observed ${Math.floor(days)} days ago.` });
  const score = Math.max(0, Math.min(100, f.reduce((s, x) => s + x.points, 0)));
  return { score, factors: f };
}

export function severityFor(category: Category, override?: Severity | null): Severity { return override ?? CATEGORY_SEVERITY[category]; }

/**
 * System promotion REPORTED → SUSPECTED needs two independent sources: one participant, however
 * much evidence it attaches, can never put an address on other organizations' radar alone.
 * VERIFIED always needs people.
 */
export const SUSPECT_MIN_CONFIDENCE = 35;
export const SUSPECT_MIN_SOURCES = 2;
export function shouldSuspect(score: number, independentSources: number) {
  return score >= SUSPECT_MIN_CONFIDENCE && independentSources >= SUSPECT_MIN_SOURCES;
}
