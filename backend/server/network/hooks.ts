/**
 * After a production evaluation (never a Playground run):
 *  - matches against active intelligence are recorded (threat_matches), raised as an organization
 *    alert and sent as `threat.match.detected` to the organization's webhooks;
 *  - security findings (not policy violations) become firewall observations, subject to the
 *    organization's sharing mode. Exceeding a limit or a blocklist is configuration, not a threat.
 */
import { Db, q } from '../db';
import { newId } from '../lib/util';
import { CheckResult } from '../engine/checks';
import { Context } from '../engine/context';
import { SUPPORTED } from '../solana/programs';
import { alert, attempt, emit } from '../services/webhooks';
import { Intel } from './matching';
import { Category, Chain, IndicatorType, isChain } from './model';
import { ingest } from './service';

const U64_MAX = '18446744073709551615';

export async function afterEvaluation(db: Db, e: { orgId: string; agent: any; evaluationId: string; network: string; decision: string; checks: CheckResult[]; intel: Intel; ctx: Context }) {
  const deliveries: string[] = [];
  const acted = e.intel.matches.filter((m) => m.status === 'VERIFIED' || m.status === 'SUSPECTED');
  for (const m of acted) {
    await q(db, `INSERT INTO threat_matches(id, indicator_id, evaluation_id, org_id, agent_id, matched_field, match_type, status_at_evaluation, confidence_at_evaluation, severity_at_evaluation, policy_action, resulting_decision, intelligence_version)
      VALUES ($1,$2,$3,$4,$5,$6,'EXACT',$7,$8,$9,$10,$11,$12)`, [newId('tmt'), m.indicatorId, e.evaluationId, e.orgId, e.agent.id, m.matchedField, m.status, m.confidence, m.severity, m.policyAction, e.decision, e.intel.intelligenceVersion ?? 0]);
  }
  if (acted.length) {
    const top = acted[0];
    const enforced = e.agent.integration_mode === 'ENFORCED_EXECUTION';
    // wording: a decision is only "enforced" where the signer verifies Intercept authorizations
    const outcome = e.decision === 'DENY' ? (enforced ? 'authorization denied' : 'transaction flagged (evaluation mode: not enforced by Intercept)') : e.decision === 'REQUIRE_APPROVAL' ? 'held for approval' : 'allowed by your policy';
    const sev = top.severity === 'CRITICAL' ? 'CRITICAL' : top.severity === 'HIGH' ? 'HIGH' : top.severity === 'MEDIUM' ? 'MEDIUM' : 'LOW';
    const a = await alert(db, { orgId: e.orgId, agentId: e.agent.id, evaluationId: e.evaluationId, type: top.status === 'VERIFIED' ? 'NETWORK_VERIFIED_THREAT' : 'NETWORK_SUSPECTED_THREAT', severity: sev,
      message: `${e.agent.name}: ${top.matchedField.replace(/_/g, ' ')} matches a ${top.status.toLowerCase()} ${top.category.toLowerCase().replace(/_/g, ' ')} (confidence ${top.confidence}, intelligence v${e.intel.intelligenceVersion}); policy ${top.policyAction}; ${outcome}.` });
    deliveries.push(...a.deliveries);
    deliveries.push(...await emit(db, e.orgId, 'threat.match.detected', { evaluationId: e.evaluationId, agentId: e.agent.id, decision: e.decision, enforced, intelligenceVersion: e.intel.intelligenceVersion,
      matches: acted.map((m) => ({ indicatorId: m.indicatorId, matchedField: m.matchedField, value: m.value, category: m.category, severity: m.severity, confidence: m.confidence, status: m.status, policyAction: m.policyAction })) }));
  }
  for (const d of deliveries) await attempt(db, d).catch(() => undefined);

  if (!isChain(e.network)) return;
  for (const o of findings(e.checks, e.ctx)) {
    await ingest(db, { orgId: e.orgId, agentId: e.agent.id, sourceType: o.source, sourceReference: e.evaluationId, chain: e.network as Chain, subjectType: o.type, subjectValue: o.value, category: o.category,
      evidence: { checkCode: o.code, messageHash: e.ctx.decoded.messageHash, simulation: e.ctx.simulation?.status ?? null }, dedupScope: new Date().toISOString().slice(0, 10), correlationId: e.evaluationId }).catch(() => undefined);
  }
}

/** Security findings worth sharing as observations (low weight; never enough alone to reach other organizations). */
export function findings(checks: CheckResult[], ctx: Context): { code: string; source: 'FIREWALL' | 'SIMULATION'; type: IndicatorType; value: string; category: Category }[] {
  const out: ReturnType<typeof findings> = [];
  const failed = (code: string) => checks.some((c) => c.code === code && c.status === 'FAILED');
  if (failed('SEC_UNEXPECTED_OUTFLOW')) for (const p of ctx.decoded.unknownPrograms) if (!SUPPORTED.has(p)) out.push({ code: 'SEC_UNEXPECTED_OUTFLOW', source: 'SIMULATION', type: 'CONTRACT', value: p, category: 'UNAUTHORIZED_TRANSFER' });
  for (const i of ctx.allInstructions) for (const ef of i.effects as any[]) {
    if (ef.kind === 'TOKEN_APPROVE' && ef.amount === U64_MAX && failed('SEC_DELEGATE_APPROVAL') && !SUPPORTED.has(ef.delegate)) out.push({ code: 'SEC_DELEGATE_APPROVAL', source: 'FIREWALL', type: 'ADDRESS', value: ef.delegate, category: 'DANGEROUS_APPROVAL' });
    if (ef.kind === 'SET_AUTHORITY' && ef.newAuthority && failed('SEC_AUTHORITY_CHANGE')) out.push({ code: 'SEC_AUTHORITY_CHANGE', source: 'FIREWALL', type: 'ADDRESS', value: ef.newAuthority, category: 'DANGEROUS_APPROVAL' });
  }
  return out;
}
