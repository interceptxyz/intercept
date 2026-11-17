/**
 * Transaction processing: decode → simulate → risk + firewall → decision → record.
 * In ENFORCED_EXECUTION mode an ALLOW (or an approved REQUIRE_APPROVAL) yields a signed,
 * single-use execution authorization bound to the exact message hash.
 */
import { sign as edSign, verify as edVerify, createPublicKey } from 'crypto';
import { Db, one, q, tx } from '../db';
import { config } from '../lib/config';
import { Dec, HttpError, bad, dec, decStr, newId, notFound } from '../lib/util';
import { parsePolicy } from '../policy/schema';
import { DecodeError, parseTransaction } from '../solana/decode';
import { Network, connection } from '../solana/rpc';
import { buildContext, fmtUsd } from '../engine/context';
import { History, decide, firewallChecks, riskChecks, systemChecks } from '../engine/checks';
import { alert, emit } from './webhooks';
import { audit } from './audit';
import { recordCustomer } from './feed';

export interface EvaluateInput {
  orgId: string; agentId: string; transaction: string; source: 'api' | 'console'; kind: 'evaluate' | 'execution_request';
  apiKeyId: string | null; actorId: string; reference?: string | null; ip?: string | null;
}

async function history(db: Db, agentId: string, programs: string[]): Promise<History> {
  const rows = await q(db, `SELECT value_usd, value_certain, decoded->'programs' AS programs FROM evaluations
    WHERE agent_id = $1 AND created_at > now() - interval '24 hours'
      AND (decision = 'ALLOW' OR approval_status = 'APPROVED')`, [agentId]);
  let daily: Dec | null = 0n;
  const per: Record<string, Dec> = {};
  for (const r of rows) {
    if (r.value_usd === null) { daily = null; continue; }
    const v = dec(r.value_usd);
    if (daily !== null) daily += v;
    for (const p of (r.programs ?? []) as string[]) if (programs.includes(p)) per[p] = (per[p] ?? 0n) + v;
  }
  return { dailySpendUsd: daily, protocolSpendUsd: per };
}

export async function evaluate(db: Db, input: EvaluateInput) {
  const t0 = Date.now();
  const agent = await one(db, `SELECT a.*, o.emergency_stop FROM agents a JOIN organizations o ON o.id = a.org_id WHERE a.id = $1 AND a.org_id = $2`, [input.agentId, input.orgId]);
  if (!agent) throw notFound('Agent');
  if (input.kind === 'execution_request' && agent.integration_mode !== 'ENFORCED_EXECUTION') throw new HttpError(409, 'NOT_ENFORCED', 'This agent is in EVALUATION mode; switch it to ENFORCED_EXECUTION to request execution authorizations.');
  const pv = await one(db, 'SELECT config FROM policy_versions WHERE policy_id = $1 AND version = $2 AND org_id = $3', [agent.policy_id, agent.policy_version, input.orgId]);
  if (!pv) throw new HttpError(409, 'NO_POLICY', 'The agent has no active policy version.');
  const parsed = parsePolicy(pv.config);
  if (!parsed.ok) throw new HttpError(500, 'POLICY_INVALID', 'Stored policy is invalid.');
  const policy = parsed.config;

  let vtx;
  try { vtx = parseTransaction(input.transaction); } catch (e) {
    if (e instanceof DecodeError) throw bad(`TX_${e.code}`, e.message);
    throw e;
  }
  const network = agent.network as Network;
  const ctx = await buildContext(vtx, { conn: connection(network), network, wallet: agent.wallet, runSimulation: true });
  const h = await history(db, agent.id, ctx.decoded.programs);
  const checks = [
    ...systemChecks({ status: agent.status, mode: agent.integration_mode, walletVerified: !!agent.wallet_verified_at, orgEmergencyStop: agent.emergency_stop }),
    ...firewallChecks(ctx, policy),
    ...riskChecks(ctx, policy, h),
  ];
  const { decision, reasons } = decide(checks);
  const latency = Date.now() - t0;
  const id = newId('evl');
  const approvalExpires = decision === 'REQUIRE_APPROVAL' ? new Date(Date.now() + policy.execution.approvalTtlSecs * 1000) : null;

  const decoded = {
    format: ctx.decoded.format, messageHash: ctx.decoded.messageHash, feePayer: ctx.decoded.feePayer, signers: ctx.decoded.signers,
    writable: ctx.decoded.writable, programs: ctx.decoded.programs, unknownPrograms: ctx.decoded.unknownPrograms,
    lookupTables: ctx.decoded.lookupTables, complete: ctx.decoded.complete,
    instructions: ctx.allInstructions.map((i) => ({ index: i.index, stackHeight: i.stackHeight, program: i.program, programName: i.programName, supported: i.supported, effects: i.effects })),
    transfers: ctx.transfers,
    flows: {
      source: ctx.flowSource,
      outflows: [...ctx.outflows.values()].map(flowView), inflows: [...ctx.inflows.values()].map(flowView),
    },
    wallet: ctx.wallet, walletConfigured: ctx.walletConfigured, issues: [...ctx.decoded.issues, ...ctx.rpcIssues, ...ctx.priceErrors, ...ctx.valueIssues],
  };
  const sim = ctx.simulation && { status: ctx.simulation.status, reason: ctx.simulation.reason, slot: ctx.simulation.slot, error: ctx.simulation.error, unitsConsumed: ctx.simulation.unitsConsumed,
    logs: ctx.simulation.logs, solChanges: ctx.simulation.solChanges, tokenChanges: ctx.simulation.tokenChanges, trackedAccounts: ctx.simulation.trackedAccounts, network };

  const result = await tx(async (c) => {
    await c.query(`INSERT INTO evaluations(id, org_id, agent_id, api_key_id, source, kind, network, policy_id, policy_version, message_hash, decision, reasons,
        risk_checks, firewall_checks, decoded, simulation, value_usd, value_certain, client_reference, approval_status, approval_expires_at, latency_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [id, input.orgId, agent.id, input.apiKeyId, input.source, input.kind, network, agent.policy_id, agent.policy_version, ctx.decoded.messageHash, decision,
        JSON.stringify(reasons), JSON.stringify(checks.filter((x) => x.category === 'RISK')), JSON.stringify(checks.filter((x) => x.category !== 'RISK')),
        JSON.stringify(decoded), sim ? JSON.stringify(sim) : null, ctx.valueUsd === null ? null : decStr(ctx.valueUsd), ctx.valueUsd !== null && ctx.flowSource === 'simulation',
        input.reference ?? null, decision === 'REQUIRE_APPROVAL' ? 'PENDING' : null, approvalExpires, latency]);
    await c.query('UPDATE agents SET last_activity_at = now() WHERE id = $1', [agent.id]);
    const deliveries: string[] = [];
    if (decision === 'DENY') {
      deliveries.push(...await emit(c, input.orgId, 'evaluation.denied', { evaluationId: id, agentId: agent.id, reasons }));
      const critical = checks.find((x) => x.effect === 'DENY' && x.severity === 'CRITICAL');
      if (critical) deliveries.push(...(await alert(c, { orgId: input.orgId, agentId: agent.id, evaluationId: id, type: critical.code, severity: 'CRITICAL', message: `${agent.name}: ${critical.reason}` })).deliveries);
    }
    if (decision === 'REQUIRE_APPROVAL') {
      deliveries.push(...await emit(c, input.orgId, 'evaluation.approval_required', { evaluationId: id, agentId: agent.id, valueUsd: fmtUsd(ctx.valueUsd), reasons, expiresAt: approvalExpires }));
      deliveries.push(...(await alert(c, { orgId: input.orgId, agentId: agent.id, evaluationId: id, type: 'APPROVAL_REQUIRED', severity: 'MEDIUM', message: `${agent.name}: a transaction is waiting for approval.` })).deliveries);
    }
    let authorization = null;
    if (input.kind === 'execution_request' && decision === 'ALLOW') authorization = await issueAuthorization(c, { orgId: input.orgId, agentId: agent.id, evaluationId: id, messageHash: ctx.decoded.messageHash, network, ttl: policy.execution.authorizationTtlSecs });
    return { deliveries, authorization };
  });
  await recordCustomer(db, input.orgId, { decision, reasons, valueUsd: ctx.valueUsd === null ? null : decStr(ctx.valueUsd, 2), network, programs: ctx.decoded.programs, instructions: ctx.allInstructions, simStatus: ctx.simulation?.status ?? null, latencyMs: latency }).catch(() => undefined);
  return { id, result, row: await getEvaluation(db, input.orgId, id) };
}

const flowView = (a: any) => ({ asset: a.asset, mint: a.mint, raw: a.raw.toString(), decimals: a.decimals, amount: a.units === null ? null : decStr(a.units), usd: a.usd === null ? null : decStr(a.usd, 2),
  price: a.price ? { usd: a.price.usdStr, slot: a.price.slot, source: a.price.source, reference: a.price.reference, fresh: a.fresh } : null });

export async function getEvaluation(db: Db, orgId: string, id: string) {
  const e = await one(db, 'SELECT * FROM evaluations WHERE id = $1 AND org_id = $2', [id, orgId]);
  if (!e) throw notFound('Evaluation');
  const auth = await one(db, 'SELECT id, expires_at, consumed_at, signature FROM authorizations WHERE evaluation_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
  return evaluationView(e, auth);
}

export function evaluationView(e: any, auth: any = null) {
  const approval = e.approval_status === 'PENDING' && e.approval_expires_at && new Date(e.approval_expires_at) <= new Date() ? 'EXPIRED' : e.approval_status;
  return {
    id: e.id, agentId: e.agent_id, kind: e.kind, source: e.source, network: e.network, createdAt: e.created_at,
    decision: e.decision, effectiveDecision: e.decision === 'REQUIRE_APPROVAL' ? (approval === 'APPROVED' ? 'ALLOW' : approval === 'REJECTED' || approval === 'EXPIRED' ? 'DENY' : 'PENDING_APPROVAL') : e.decision,
    reasons: e.reasons, policy: { id: e.policy_id, version: e.policy_version },
    valueUsd: e.value_usd === null ? null : decStr(dec(e.value_usd), 2), valueCertain: e.value_certain,
    messageHash: e.message_hash, reference: e.client_reference,
    approval: e.decision === 'REQUIRE_APPROVAL' ? { status: approval, expiresAt: e.approval_expires_at, resolvedBy: e.resolved_by, resolvedAt: e.resolved_at } : null,
    authorization: auth ? { id: auth.id, expiresAt: auth.expires_at, consumedAt: auth.consumed_at, signature: auth.signature } : null,
    checks: { risk: e.risk_checks, security: e.firewall_checks }, decoded: e.decoded, simulation: e.simulation, latencyMs: e.latency_ms,
  };
}

// ----------------------------------------------------------------------------- approvals

export async function resolveApproval(db: Db, orgId: string, id: string, userId: string, approve: boolean, ip: string | null) {
  return tx(async (c) => {
    const e = await one(c, 'SELECT * FROM evaluations WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, orgId]);
    if (!e) throw notFound('Evaluation');
    if (e.approval_status !== 'PENDING') throw bad('NOT_PENDING', 'This transaction is not waiting for approval.');
    if (new Date(e.approval_expires_at) <= new Date()) {
      await c.query(`UPDATE evaluations SET approval_status = 'EXPIRED' WHERE id = $1`, [id]);
      throw bad('APPROVAL_EXPIRED', 'The approval window has closed; evaluate the transaction again.');
    }
    // a hard DENY reason can never be approved: only REQUIRE_APPROVAL evaluations reach here
    const status = approve ? 'APPROVED' : 'REJECTED';
    await c.query('UPDATE evaluations SET approval_status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1', [id, status, userId]);
    let authorization = null;
    if (approve && e.kind === 'execution_request') {
      const agent = await one(c, 'SELECT * FROM agents WHERE id = $1 AND org_id = $2', [e.agent_id, orgId]);
      if (agent.status !== 'ACTIVE') throw bad('AGENT_NOT_ACTIVE', 'The agent is not active.');
      const pv = await one(c, 'SELECT config FROM policy_versions WHERE policy_id = $1 AND version = $2', [e.policy_id, e.policy_version]);
      authorization = await issueAuthorization(c, { orgId, agentId: e.agent_id, evaluationId: id, messageHash: e.message_hash, network: e.network, ttl: pv.config.execution?.authorizationTtlSecs ?? 120 });
    }
    await audit(c, { orgId, actorType: 'user', actorId: userId, action: approve ? 'evaluation.approve' : 'evaluation.reject', targetType: 'evaluation', targetId: id, ip });
    const deliveries = await emit(c, orgId, 'evaluation.resolved', { evaluationId: id, agentId: e.agent_id, status, resolvedBy: userId });
    return { status, authorization, deliveries };
  });
}

// ------------------------------------------------------------------------- authorizations

export interface AuthorizationPayload { v: 1; kid: string; aid: string; eid: string; org: string; agent: string; net: string; mh: string; iat: number; exp: number }

async function issueAuthorization(db: Db, a: { orgId: string; agentId: string; evaluationId: string; messageHash: string; network: string; ttl: number }) {
  const cfg = config();
  const aid = newId('atz');
  const iat = Math.floor(Date.now() / 1000), exp = iat + a.ttl;
  const payload: AuthorizationPayload = { v: 1, kid: cfg.keyId, aid, eid: a.evaluationId, org: a.orgId, agent: a.agentId, net: a.network, mh: a.messageHash, iat, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = edSign(null, Buffer.from(body), cfg.signingKey).toString('base64url');
  await q(db, 'INSERT INTO authorizations(id, org_id, agent_id, evaluation_id, message_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [aid, a.orgId, a.agentId, a.evaluationId, a.messageHash, new Date(exp * 1000)]);
  return { id: aid, token: `${body}.${sig}`, expiresAt: new Date(exp * 1000).toISOString(), messageHash: a.messageHash };
}

/** Offline verification, as an execution environment does it with the published public key. */
export function verifyAuthorizationToken(token: string, publicKeyB64: string): AuthorizationPayload | null {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]);
  const ok = edVerify(null, Buffer.from(body), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(sig, 'base64url'));
  if (!ok) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as AuthorizationPayload;
  return p.exp > Date.now() / 1000 ? p : null;
}

/** Online single-use consumption: the signer calls this right before signing. */
export async function consumeAuthorization(db: Db, orgId: string, agentId: string, aid: string, messageHash: string) {
  const r = await one(db, `UPDATE authorizations SET consumed_at = now() WHERE id = $1 AND org_id = $2 AND agent_id = $3 AND message_hash = $4 AND consumed_at IS NULL AND expires_at > now() RETURNING id`, [aid, orgId, agentId, messageHash]);
  if (!r) {
    const a = await one(db, 'SELECT * FROM authorizations WHERE id = $1 AND org_id = $2 AND agent_id = $3', [aid, orgId, agentId]);
    if (!a) throw notFound('Authorization');
    if (a.message_hash !== messageHash) throw new HttpError(409, 'MESSAGE_MISMATCH', 'The transaction differs from the one that was authorized.');
    if (a.consumed_at) throw new HttpError(409, 'ALREADY_CONSUMED', 'This authorization was already used.');
    throw new HttpError(409, 'AUTHORIZATION_EXPIRED', 'This authorization has expired.');
  }
  // the agent may have been paused or the org stopped after the authorization was issued
  const st = await one(db, 'SELECT a.status, o.emergency_stop FROM agents a JOIN organizations o ON o.id = a.org_id WHERE a.id = $1', [agentId]);
  if (st.status !== 'ACTIVE' || st.emergency_stop) {
    // stays consumed: a stopped agent must request a new authorization after it is resumed
    throw new HttpError(409, 'AGENT_NOT_ACTIVE', 'The agent was paused or the organization emergency stop is active.');
  }
  return { id: aid, consumed: true };
}
