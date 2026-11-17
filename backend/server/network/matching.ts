/**
 * Threat Matching Engine. Extracts the subjects of a decoded transaction (programs, recipients,
 * delegates, new authorities, tokens, signers), looks them up in the registry (one indexed batch
 * query, cached per instance) and turns matches into one firewall check whose effect comes from the
 * policy's `network` section. It never decides by itself, and "no known match" never means safe.
 *
 * Cache: no Redis in this deployment. Each instance caches lookups (positive and negative) tagged with
 * the intelligence version (the outbox sequence); the version is re-read at most every 2 s, and a
 * local write bumps it at once, so a revocation stops matching within ~2 s everywhere.
 */
import { Db, q } from '../db';
import { PolicyConfig } from '../policy/schema';
import { CheckResult } from '../engine/checks';
import { Context } from '../engine/context';
import { ACTIVE, MATCHABLE, Severity, sevRank } from './model';

const TIMEOUT = Number(process.env.NETWORK_LOOKUP_TIMEOUT_MS ?? 1500);
const VERSION_TTL = 2000, ENTRY_TTL = 60_000;
let version = 0, versionAt = 0;
const cache = new Map<string, { v: number; at: number; rows: any[] }>();
export function bumpVersion(v: number) { if (v > version) version = v; versionAt = Date.now(); cache.clear(); }
export function resetCache() { version = 0; versionAt = 0; cache.clear(); }
export const cacheStats = { hits: 0, misses: 0 };

async function currentVersion(db: Db) {
  if (Date.now() - versionAt < VERSION_TTL) return version;
  const r = await q(db, 'SELECT COALESCE(max(sequence_number), 0)::bigint v FROM intelligence_events');
  const v = Number(r[0].v);
  if (v !== version) cache.clear();
  version = v; versionAt = Date.now();
  return v;
}

/** Batch lookup of normalized values on one chain. Returns active and disputed indicators per value. */
export async function lookup(db: Db, chain: string, values: string[]) {
  const t0 = Date.now();
  const work = (async () => {
    const v = await currentVersion(db);
    const out = new Map<string, any[]>(); const miss: string[] = [];
    for (const x of new Set(values)) {
      const c = cache.get(`${chain}|${x}`);
      if (c && c.v === v && Date.now() - c.at < ENTRY_TTL) { out.set(x, c.rows); cacheStats.hits++; } else { miss.push(x); cacheStats.misses++; }
    }
    if (miss.length) {
      const rows = await q(db, `SELECT * FROM threat_indicators WHERE chain = $1 AND value = ANY($2) AND indicator_type = ANY($3) AND status = ANY($4)`, [chain, miss, MATCHABLE, [...ACTIVE, 'DISPUTED']]);
      for (const x of miss) { const r = rows.filter((i) => i.value === x); out.set(x, r); cache.set(`${chain}|${x}`, { v, at: Date.now(), rows: r }); }
    }
    return { version: v, matches: out, cached: values.length - miss.length };
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`lookup exceeded ${TIMEOUT} ms`)), TIMEOUT); })]);
    return { ...r, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

export interface Subject { field: string; value: string }
export function subjects(ctx: Context): Subject[] {
  const out: Subject[] = [];
  const add = (field: string, value: string | null | undefined) => { if (value && !value.startsWith('#')) out.push({ field, value }); };
  for (const p of ctx.decoded.programs) add('program', p);
  for (const i of ctx.allInstructions) {
    if (i.stackHeight > 1) add('inner_program', i.program);
    for (const e of i.effects as any[]) {
      if (e.kind === 'TOKEN_APPROVE') add('delegate', e.delegate);
      if (e.kind === 'SET_AUTHORITY') add('new_authority', e.newAuthority);
      if (e.kind === 'ACCOUNT_ASSIGN') add('new_owner_program', e.newOwnerProgram);
      if (e.kind === 'TOKEN_TRANSFER' || e.kind === 'TOKEN_APPROVE') add('token', e.mint);
    }
  }
  for (const t of ctx.transfers) { add('recipient', t.recipient); add('token', t.mint); }
  for (const k of [...ctx.inflows.keys(), ...ctx.outflows.keys()]) if (k !== 'SOL') add('token', k);
  for (const s of ctx.decoded.signers) add('signer', s);
  const seen = new Set<string>();
  return out.filter((s) => { const k = s.field + s.value; if (seen.has(k)) return false; seen.add(k); return true; });
}

export type IntelStatus = 'NO_KNOWN_MATCH' | 'SUSPICIOUS' | 'VERIFIED_THREAT' | 'INTELLIGENCE_UNAVAILABLE';
export type Action = 'BLOCK' | 'REQUIRE_APPROVAL' | 'WARN' | 'ALLOW';
export interface IntelMatch { indicatorId: string; value: string; matchedField: string; indicatorType: string; category: string; severity: Severity; confidence: number; status: string; evidenceSummary: string; intelligenceVersion: number; policyAction: Action; explanation: string }
export interface Intel { status: IntelStatus; intelligenceVersion: number | null; lookupMs: number | null; subjectsChecked: number; cachedLookups: number; checkedAt: string; matches: IntelMatch[]; error: string | null }

export async function evaluateIntel(db: Db, chain: string, ctx: Context, policy: PolicyConfig, summary: (i: any) => string): Promise<Intel> {
  const subs = subjects(ctx);
  const at = new Date().toISOString();
  try {
    const r = await lookup(db, chain, subs.map((s) => s.value));
    const N = policy.network;
    const matches: IntelMatch[] = [];
    for (const s of subs) for (const i of r.matches.get(s.value) ?? []) {
      const strongEnough = i.confidence >= N.minConfidence && sevRank(i.severity) >= sevRank(N.minSeverity);
      const configured: Action = i.status === 'VERIFIED' ? N.verified : i.status === 'SUSPECTED' ? N.suspected : 'WARN';
      // below the organization's thresholds a match can only warn
      const action: Action = !strongEnough && (configured === 'BLOCK' || configured === 'REQUIRE_APPROVAL') ? 'WARN' : configured;
      const what = String(i.category).toLowerCase().replace(/_/g, ' ');
      matches.push({ indicatorId: i.id, value: s.value, matchedField: s.field, indicatorType: i.indicator_type, category: i.category, severity: i.severity, confidence: i.confidence, status: i.status,
        evidenceSummary: summary(i), intelligenceVersion: Number(i.intelligence_version), policyAction: action,
        explanation: `The ${s.field.replace(/_/g, ' ')} ${s.value.slice(0, 6)}…${s.value.slice(-4)} matches a ${i.status.toLowerCase()} ${what} indicator (confidence ${i.confidence}/100, ${i.severity.toLowerCase()}). `
          + (i.status === 'DISPUTED' ? 'It is disputed, so it is informational only.' : !strongEnough && action !== configured ? `Below your thresholds (confidence ${N.minConfidence}, severity ${N.minSeverity.toLowerCase()}), so your policy only warns.` : `Your policy action for ${i.status.toLowerCase()} threats is ${action}.`) });
    }
    const status: IntelStatus = matches.some((m) => m.status === 'VERIFIED') ? 'VERIFIED_THREAT' : matches.some((m) => m.status === 'SUSPECTED') ? 'SUSPICIOUS' : 'NO_KNOWN_MATCH';
    return { status, intelligenceVersion: r.version, lookupMs: r.ms, subjectsChecked: subs.length, cachedLookups: r.cached, checkedAt: at, matches, error: null };
  } catch (e: any) {
    return { status: 'INTELLIGENCE_UNAVAILABLE', intelligenceVersion: null, lookupMs: null, subjectsChecked: subs.length, cachedLookups: 0, checkedAt: at, matches: [], error: String(e.message ?? e).slice(0, 160) };
  }
}

const EFFECT: Record<Action, CheckResult['effect']> = { BLOCK: 'DENY', REQUIRE_APPROVAL: 'REQUIRE_APPROVAL', WARN: 'NONE', ALLOW: 'NONE' };
const ORDER: Action[] = ['BLOCK', 'REQUIRE_APPROVAL', 'WARN', 'ALLOW'];
/** The single firewall check carrying network intelligence into the existing decision. */
export function networkCheck(intel: Intel, policy: PolicyConfig): CheckResult {
  const base = { check: 'NETWORK_INTELLIGENCE', category: 'SECURITY' as const, unit: null, limit: null };
  if (intel.status === 'INTELLIGENCE_UNAVAILABLE') {
    const a = policy.network.unavailable as Action;
    return { ...base, code: 'SEC_NETWORK_UNAVAILABLE', status: 'UNCERTAIN', effect: EFFECT[a], severity: 'MEDIUM', observed: null, reason: `Intercept Network intelligence was unavailable (${intel.error}); your fallback is ${a}. The transaction was not treated as safe.` };
  }
  if (!intel.matches.length) return { ...base, code: 'SEC_NETWORK_THREAT', status: 'PASSED', effect: 'NONE', severity: 'LOW', observed: `${intel.subjectsChecked} subjects`, reason: `No known match in Intercept Network (version ${intel.intelligenceVersion}). This does not mean the transaction is safe.` };
  const top = [...intel.matches].sort((a, b) => ORDER.indexOf(a.policyAction) - ORDER.indexOf(b.policyAction) || b.confidence - a.confidence)[0];
  const effect = EFFECT[top.policyAction];
  return { ...base, code: 'SEC_NETWORK_THREAT', status: effect === 'NONE' ? 'WARNING' : 'FAILED', effect, severity: top.severity === 'CRITICAL' ? 'CRITICAL' : sevRank(top.severity) >= sevRank('HIGH') ? 'HIGH' : 'MEDIUM',
    observed: intel.matches.map((m) => `${m.value} (${m.category}, ${m.status}, ${m.confidence})`).join(', '), reason: top.explanation };
}
