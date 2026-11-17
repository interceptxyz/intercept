/**
 * Policy configuration (schema version 1).
 *
 * Units: every *Usd field is a decimal string in US dollars (max 9 decimals); every *Bps field an
 * integer in basis points (1 bps = 0.01%). Floats are rejected.
 *
 * Semantics:
 *  - An omitted or null limit means "no limit configured"; the check reports NOT_CONFIGURED.
 *  - Empty allowlist = no allowlist (everything not blocked is allowed by that rule).
 *    A non-empty allowlist = only listed entries. Infrastructure programs (System, Compute Budget,
 *    Memo, Associated Token Account, SPL Token, Token-2022) are always allowed by the program
 *    allowlist, because the token/recipient/authority rules inspect what they do.
 *  - Precedence: blocklist > allowlist. Decision precedence: DENY > REQUIRE_APPROVAL > ALLOW.
 *  - A configured check that cannot be evaluated (price unavailable, simulation unavailable,
 *    unrecognised program) is UNCERTAIN: failClosed=true → DENY, failClosed=false → REQUIRE_APPROVAL.
 *    Never ALLOW.
 *  - Checks without a validated model yet (daily loss, drawdown, minimum liquidity) are accepted in
 *    the configuration and reported UNSUPPORTED; their effect is `execution.unsupportedChecks`.
 */
import { z } from 'zod';
import { isBase58Address } from '../lib/util';

const usd = z.string().regex(/^\d{1,15}(\.\d{1,9})?$/, 'decimal string in USD, e.g. "1000" or "12.5"');
const bps = z.number().int().min(0).max(10_000);
const addr = z.string().refine(isBase58Address, 'address (base58)');
const addrList = z.array(addr).max(200).default([]);

export const policyConfigSchema = z.object({
  version: z.literal(1).default(1),
  risk: z.object({
    maxTransactionValueUsd: usd.nullable().default(null),
    maxDailySpendUsd: usd.nullable().default(null),
    maxPositionSizeUsd: usd.nullable().default(null),
    maxPortfolioExposureUsd: usd.nullable().default(null),
    maxAssetConcentrationBps: bps.nullable().default(null),
    maxLeverage: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).nullable().default(null),
    maxDailyLossBps: bps.nullable().default(null),
    maxDrawdownBps: bps.nullable().default(null),
    maxSlippageBps: bps.nullable().default(null),
    minLiquidityUsd: usd.nullable().default(null),
    protocolExposureUsd: z.record(addr, usd).default({}),
  }).strict().default({}),
  security: z.object({
    allowedPrograms: addrList,
    blockedPrograms: addrList,
    allowedRecipients: addrList,
    blockedRecipients: addrList,
    allowedMints: addrList,
    restrictedMints: addrList,
    blockUnknownRecipients: z.boolean().default(true),
    allowDelegateApprovals: z.boolean().default(false),
    allowAuthorityChanges: z.boolean().default(false),
    requireSimulation: z.boolean().default(true),
    unknownInstructions: z.enum(['DENY', 'REQUIRE_APPROVAL', 'ALLOW']).default('DENY'),
  }).strict().default({}),
  execution: z.object({
    requireApprovalAboveUsd: usd.nullable().default(null),
    failClosed: z.boolean().default(true),
    unsupportedChecks: z.enum(['DENY', 'REQUIRE_APPROVAL', 'WARN']).default('REQUIRE_APPROVAL'),
    approvalTtlSecs: z.number().int().min(60).max(7 * 86_400).default(3_600),
    authorizationTtlSecs: z.number().int().min(10).max(600).default(120),
  }).strict().default({}),
  /** Intercept Network: what a match against shared threat intelligence does. The engine decides; intelligence only informs. */
  network: z.object({
    verified: z.enum(['BLOCK', 'REQUIRE_APPROVAL', 'WARN', 'ALLOW']).default('BLOCK'),
    suspected: z.enum(['BLOCK', 'REQUIRE_APPROVAL', 'WARN', 'ALLOW']).default('WARN'),
    unavailable: z.enum(['BLOCK', 'REQUIRE_APPROVAL', 'WARN']).default('WARN'),
    minConfidence: z.number().int().min(0).max(100).default(50),
    minSeverity: z.enum(['INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  }).strict().default({}),
}).strict();

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export function parsePolicy(input: unknown): { ok: true; config: PolicyConfig } | { ok: false; issues: { path: string; message: string }[] } {
  const r = policyConfigSchema.safeParse(input ?? {});
  if (!r.success) return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  const c = r.data;
  const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x));
  const issues: { path: string; message: string }[] = [];
  for (const [x, y, p] of [[c.security.allowedPrograms, c.security.blockedPrograms, 'programs'], [c.security.allowedRecipients, c.security.blockedRecipients, 'recipients'], [c.security.allowedMints, c.security.restrictedMints, 'mints']] as const) {
    const o = overlap(x, y);
    if (o.length) issues.push({ path: `security.${p}`, message: `listed as both allowed and blocked: ${o.join(', ')} (blocked wins; remove one)` });
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, config: c };
}

export const DEFAULT_POLICY: PolicyConfig = policyConfigSchema.parse({
  risk: { maxTransactionValueUsd: '1000', maxDailySpendUsd: '5000', maxSlippageBps: 50 },
  security: { blockUnknownRecipients: true, requireSimulation: true },
  execution: { requireApprovalAboveUsd: '2500', failClosed: true },
});

/** Stable JSON for hashing (sorted keys). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
