/**
 * Deterministic risk checks, firewall rules and the decision. Pure functions of the context, the
 * policy and the history: the same inputs always give the same decision.
 */
import { PolicyConfig } from '../policy/schema';
import { Dec, dec, decStr } from '../lib/util';
import { INFRASTRUCTURE, PROGRAM_NAMES, SUPPORTED, WSOL_MINT } from '../solana/programs';
import { AssetAmount, Context, SOL, STABLES } from './context';

export type CheckStatus = 'PASSED' | 'FAILED' | 'UNCERTAIN' | 'UNSUPPORTED' | 'NOT_CONFIGURED' | 'NOT_APPLICABLE' | 'WARNING';
export type Effect = 'DENY' | 'REQUIRE_APPROVAL' | 'NONE';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Decision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface CheckResult {
  check: string; code: string; category: 'RISK' | 'SECURITY' | 'SYSTEM';
  status: CheckStatus; effect: Effect; severity: Severity;
  observed: string | null; limit: string | null; unit: string | null; reason: string;
}

export interface History {
  /** USD value authorized (ALLOW or approved) for this agent in the last 24 h, excluding this transaction */
  dailySpendUsd: Dec | null;
  /** same, per program id invoked */
  protocolSpendUsd: Record<string, Dec>;
}

export interface AgentState { status: 'ACTIVE' | 'PAUSED' | 'REVOKED'; mode: 'EVALUATION' | 'ENFORCED_EXECUTION'; walletVerified: boolean; orgEmergencyStop: boolean }

const usd = (d: Dec | null) => (d === null ? null : decStr(d, 2));
const r = (x: Omit<CheckResult, 'effect'> & { effect?: Effect }): CheckResult => ({ effect: 'NONE', ...x });
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const name = (p: string) => PROGRAM_NAMES[p] ?? short(p);

/** Effect of a check that cannot be evaluated with certainty. Never NONE (fail-safe). */
const uncertainEffect = (p: PolicyConfig): Effect => (p.execution.failClosed ? 'DENY' : 'REQUIRE_APPROVAL');
const unsupportedEffect = (p: PolicyConfig): Effect => (p.execution.unsupportedChecks === 'WARN' ? 'NONE' : p.execution.unsupportedChecks);

// ------------------------------------------------------------------------------------------- risk

export function riskChecks(ctx: Context, p: PolicyConfig, h: History): CheckResult[] {
  const R = p.risk;
  const out: CheckResult[] = [];
  const value = ctx.valueUsd;
  const valueNote = ctx.valueIssues.join('; ');
  const hasUnknown = ctx.decoded.unknownPrograms.length > 0;

  const limitCheck = (check: string, code: string, limitStr: string | null, observed: Dec | null, what: string, severity: Severity = 'HIGH') => {
    if (limitStr === null) return out.push(r({ check, code, category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: usd(observed), limit: null, unit: 'USD', reason: 'No limit configured.' }));
    const limit = dec(limitStr);
    if (observed === null) return out.push(r({ check, code, category: 'RISK', status: 'UNCERTAIN', effect: uncertainEffect(p), severity, observed: null, limit: limitStr, unit: 'USD', reason: `${what} could not be valued: ${valueNote || 'price data unavailable'}.` }));
    const fail = observed > limit;
    out.push(r({ check, code, category: 'RISK', status: fail ? 'FAILED' : 'PASSED', effect: fail ? 'DENY' : 'NONE', severity, observed: usd(observed), limit: limitStr, unit: 'USD', reason: fail ? `${what} ${usd(observed)} USD exceeds the limit of ${limitStr} USD.` : `${what} is within the limit.` }));
  };

  limitCheck('MAX_TRANSACTION_VALUE', 'RISK_MAX_TX_VALUE', R.maxTransactionValueUsd, value, 'Transaction value');
  limitCheck('MAX_DAILY_SPEND', 'RISK_DAILY_SPEND', R.maxDailySpendUsd, value === null || h.dailySpendUsd === null ? null : h.dailySpendUsd + value, 'Spending over the last 24 hours including this transaction');

  // post-transaction holdings
  const post = new Map<string, { a: AssetAmount; usd: Dec | null }>();
  let portfolioUncertain = ctx.holdingsPre === null;
  if (ctx.holdingsPre) {
    const assets = new Set([...ctx.holdingsPre.keys(), ...ctx.inflows.keys(), ...ctx.outflows.keys()]);
    for (const k of assets) {
      const pre = ctx.holdingsPre.get(k), inn = ctx.inflows.get(k), outA = ctx.outflows.get(k);
      const any = pre ?? inn ?? outA!;
      const rawPost = (pre?.raw ?? 0n) + (inn?.raw ?? 0n) - (outA?.raw ?? 0n);
      const priced = any.price && any.fresh && any.decimals !== null;
      const v = priced ? (dec(0) + ((rawPost < 0n ? 0n : rawPost) * any.price!.usd) / 10n ** BigInt(any.decimals!)) : null;
      if (v === null && rawPost > 0n) portfolioUncertain = true;
      post.set(k, { a: any, usd: v });
    }
  }
  const increased = [...ctx.inflows.keys()];

  // position size: every asset this transaction increases
  if (R.maxPositionSizeUsd === null) out.push(r({ check: 'MAX_POSITION_SIZE', code: 'RISK_POSITION_SIZE', category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: null, limit: null, unit: 'USD', reason: 'No limit configured.' }));
  else if (!increased.length) out.push(r({ check: 'MAX_POSITION_SIZE', code: 'RISK_POSITION_SIZE', category: 'RISK', status: 'NOT_APPLICABLE', severity: 'LOW', observed: null, limit: R.maxPositionSizeUsd, unit: 'USD', reason: 'The transaction does not increase any position.' }));
  else if (!ctx.holdingsPre) out.push(r({ check: 'MAX_POSITION_SIZE', code: 'RISK_POSITION_SIZE', category: 'RISK', status: 'UNCERTAIN', effect: uncertainEffect(p), severity: 'HIGH', observed: null, limit: R.maxPositionSizeUsd, unit: 'USD', reason: 'Wallet holdings are unavailable.' }));
  else {
    const limit = dec(R.maxPositionSizeUsd);
    let worst: { k: string; v: Dec | null } | null = null;
    for (const k of increased) { const v = post.get(k)?.usd ?? null; if (v === null) { worst = { k, v: null }; break; } if (!worst || (worst.v !== null && v > worst.v)) worst = { k, v }; }
    if (worst!.v === null) out.push(r({ check: 'MAX_POSITION_SIZE', code: 'RISK_POSITION_SIZE', category: 'RISK', status: 'UNCERTAIN', effect: uncertainEffect(p), severity: 'HIGH', observed: null, limit: R.maxPositionSizeUsd, unit: 'USD', reason: `No fresh price for ${assetName(worst!.k)}.` }));
    else { const fail = worst!.v > limit; out.push(r({ check: 'MAX_POSITION_SIZE', code: 'RISK_POSITION_SIZE', category: 'RISK', status: fail ? 'FAILED' : 'PASSED', effect: fail ? 'DENY' : 'NONE', severity: 'HIGH', observed: usd(worst!.v), limit: R.maxPositionSizeUsd, unit: 'USD', reason: fail ? `The ${assetName(worst!.k)} position would be ${usd(worst!.v)} USD, above ${R.maxPositionSizeUsd} USD.` : 'Every increased position stays within the limit.' })); }
  }

  // portfolio exposure: total non-stablecoin value after the transaction
  const totals = () => { let all: Dec = 0n, risky: Dec = 0n; for (const [k, v] of post) { if (v.usd === null) continue; all += v.usd; if (!STABLES.has(k)) risky += v.usd; } return { all, risky }; };
  if (R.maxPortfolioExposureUsd === null) out.push(r({ check: 'MAX_PORTFOLIO_EXPOSURE', code: 'RISK_PORTFOLIO_EXPOSURE', category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: null, limit: null, unit: 'USD', reason: 'No limit configured.' }));
  else if (portfolioUncertain) out.push(r({ check: 'MAX_PORTFOLIO_EXPOSURE', code: 'RISK_PORTFOLIO_EXPOSURE', category: 'RISK', status: 'UNCERTAIN', effect: uncertainEffect(p), severity: 'MEDIUM', observed: null, limit: R.maxPortfolioExposureUsd, unit: 'USD', reason: 'Some holdings are unpriced or the wallet is unavailable.' }));
  else { const { risky } = totals(); const fail = risky > dec(R.maxPortfolioExposureUsd); out.push(r({ check: 'MAX_PORTFOLIO_EXPOSURE', code: 'RISK_PORTFOLIO_EXPOSURE', category: 'RISK', status: fail ? 'FAILED' : 'PASSED', effect: fail ? 'DENY' : 'NONE', severity: 'MEDIUM', observed: usd(risky), limit: R.maxPortfolioExposureUsd, unit: 'USD', reason: fail ? 'Non-stablecoin holdings after the transaction exceed the exposure limit.' : 'Exposure is within the limit.' })); }

  // concentration of any asset this transaction increases
  if (R.maxAssetConcentrationBps === null) out.push(r({ check: 'MAX_ASSET_CONCENTRATION', code: 'RISK_CONCENTRATION', category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: null, limit: null, unit: 'bps', reason: 'No limit configured.' }));
  else if (!increased.length) out.push(r({ check: 'MAX_ASSET_CONCENTRATION', code: 'RISK_CONCENTRATION', category: 'RISK', status: 'NOT_APPLICABLE', severity: 'LOW', observed: null, limit: String(R.maxAssetConcentrationBps), unit: 'bps', reason: 'The transaction does not increase any position.' }));
  else if (portfolioUncertain) out.push(r({ check: 'MAX_ASSET_CONCENTRATION', code: 'RISK_CONCENTRATION', category: 'RISK', status: 'UNCERTAIN', effect: uncertainEffect(p), severity: 'MEDIUM', observed: null, limit: String(R.maxAssetConcentrationBps), unit: 'bps', reason: 'Some holdings are unpriced or the wallet is unavailable.' }));
  else {
    const { all } = totals();
    let worst = 0n, which = '';
    for (const k of increased) { const v = post.get(k)?.usd ?? 0n; const share = all === 0n ? 0n : (v * 10_000n) / all; if (share > worst) { worst = share; which = k; } }
    const fail = worst > BigInt(R.maxAssetConcentrationBps);
    out.push(r({ check: 'MAX_ASSET_CONCENTRATION', code: 'RISK_CONCENTRATION', category: 'RISK', status: fail ? 'FAILED' : 'PASSED', effect: fail ? 'DENY' : 'NONE', severity: 'MEDIUM', observed: worst.toString(), limit: String(R.maxAssetConcentrationBps), unit: 'bps', reason: fail ? `${assetName(which)} would be ${worst} bps of the portfolio.` : 'Concentration is within the limit.' }));
  }

  // leverage: spot programs cannot create leverage; other programs have no validated adapter yet
  if (R.maxLeverage === null) out.push(r({ check: 'MAX_LEVERAGE', code: 'RISK_LEVERAGE', category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: null, limit: null, unit: 'x', reason: 'No limit configured.' }));
  else if (!hasUnknown) out.push(r({ check: 'MAX_LEVERAGE', code: 'RISK_LEVERAGE', category: 'RISK', status: 'NOT_APPLICABLE', severity: 'LOW', observed: '1', limit: R.maxLeverage, unit: 'x', reason: 'Only spot programs are involved: no leverage.' }));
  else out.push(r({ check: 'MAX_LEVERAGE', code: 'RISK_LEVERAGE', category: 'RISK', status: 'UNSUPPORTED', effect: unsupportedEffect(p), severity: 'HIGH', observed: null, limit: R.maxLeverage, unit: 'x', reason: `No validated leverage adapter for ${ctx.decoded.unknownPrograms.map(name).join(', ')}.` }));

  for (const [check, code, v, label] of [['MAX_DAILY_LOSS', 'RISK_DAILY_LOSS', R.maxDailyLossBps, 'daily loss'], ['MAX_DRAWDOWN', 'RISK_DRAWDOWN', R.maxDrawdownBps, 'drawdown']] as const) {
    if (v === null) out.push(r({ check, code, category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: null, limit: null, unit: 'bps', reason: 'No limit configured.' }));
    else out.push(r({ check, code, category: 'RISK', status: 'UNSUPPORTED', effect: unsupportedEffect(p), severity: 'MEDIUM', observed: null, limit: String(v), unit: 'bps', reason: `The ${label} limit needs a validated PnL accounting model, which is not available yet.` }));
  }

  // slippage: read from the swap instruction itself
  const swaps = ctx.effects.filter((e) => e.effect.kind === 'SWAP').map((e) => e.effect as Extract<typeof e.effect, { kind: 'SWAP' }>);
  if (R.maxSlippageBps === null) out.push(r({ check: 'MAX_SLIPPAGE', code: 'RISK_SLIPPAGE', category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: null, limit: null, unit: 'bps', reason: 'No limit configured.' }));
  else if (swaps.length) {
    const worst = Math.max(...swaps.map((s) => s.slippageBps));
    const fail = worst > R.maxSlippageBps;
    out.push(r({ check: 'MAX_SLIPPAGE', code: 'RISK_SLIPPAGE', category: 'RISK', status: fail ? 'FAILED' : 'PASSED', effect: fail ? 'DENY' : 'NONE', severity: 'MEDIUM', observed: String(worst), limit: String(R.maxSlippageBps), unit: 'bps', reason: fail ? `The swap accepts up to ${worst} bps of slippage, above ${R.maxSlippageBps} bps.` : 'Swap slippage tolerance is within the limit.' }));
  } else if (hasUnknown) out.push(r({ check: 'MAX_SLIPPAGE', code: 'RISK_SLIPPAGE', category: 'RISK', status: 'UNSUPPORTED', effect: unsupportedEffect(p), severity: 'MEDIUM', observed: null, limit: String(R.maxSlippageBps), unit: 'bps', reason: 'An unrecognised program may perform a swap whose slippage cannot be read.' }));
  else out.push(r({ check: 'MAX_SLIPPAGE', code: 'RISK_SLIPPAGE', category: 'RISK', status: 'NOT_APPLICABLE', severity: 'LOW', observed: null, limit: String(R.maxSlippageBps), unit: 'bps', reason: 'No swap in this transaction.' }));

  // minimum liquidity of assets received in a swap
  if (R.minLiquidityUsd === null) out.push(r({ check: 'MIN_LIQUIDITY', code: 'RISK_LIQUIDITY', category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: null, limit: null, unit: 'USD', reason: 'No limit configured.' }));
  else if (!swaps.length) out.push(r({ check: 'MIN_LIQUIDITY', code: 'RISK_LIQUIDITY', category: 'RISK', status: 'NOT_APPLICABLE', severity: 'LOW', observed: null, limit: R.minLiquidityUsd, unit: 'USD', reason: 'No swap in this transaction.' }));
  else {
    const recv = [...ctx.inflows.values()].filter((a) => a.asset !== SOL);
    const min = dec(R.minLiquidityUsd);
    const missing = recv.find((a) => !a.price?.liquidityUsd);
    if (!recv.length || missing) out.push(r({ check: 'MIN_LIQUIDITY', code: 'RISK_LIQUIDITY', category: 'RISK', status: 'UNCERTAIN', effect: uncertainEffect(p), severity: 'MEDIUM', observed: null, limit: R.minLiquidityUsd, unit: 'USD', reason: missing ? `No liquidity data for ${assetName(missing.asset)}.` : 'The received asset could not be identified (simulation unavailable).' }));
    else {
      const low = recv.reduce((m, a) => (a.price!.liquidityUsd! < m.price!.liquidityUsd! ? a : m));
      const fail = low.price!.liquidityUsd! < min;
      out.push(r({ check: 'MIN_LIQUIDITY', code: 'RISK_LIQUIDITY', category: 'RISK', status: fail ? 'FAILED' : 'PASSED', effect: fail ? 'DENY' : 'NONE', severity: 'MEDIUM', observed: usd(low.price!.liquidityUsd), limit: R.minLiquidityUsd, unit: 'USD', reason: fail ? `${assetName(low.asset)} liquidity is below the minimum.` : 'Received assets meet the liquidity minimum.' }));
    }
  }

  // per-protocol exposure over 24 h
  for (const [program, limitStr] of Object.entries(R.protocolExposureUsd)) {
    if (!ctx.decoded.programs.includes(program)) { out.push(r({ check: `PROTOCOL_EXPOSURE:${program}`, code: 'RISK_PROTOCOL_EXPOSURE', category: 'RISK', status: 'NOT_APPLICABLE', severity: 'LOW', observed: null, limit: limitStr, unit: 'USD', reason: `${name(program)} is not invoked.` })); continue; }
    const observed = value === null ? null : (h.protocolSpendUsd[program] ?? 0n) + value;
    limitCheck(`PROTOCOL_EXPOSURE:${program}`, 'RISK_PROTOCOL_EXPOSURE', limitStr, observed, `Value sent through ${name(program)} over 24 hours`, 'MEDIUM');
  }

  // human approval threshold
  const t = p.execution.requireApprovalAboveUsd;
  if (t === null) out.push(r({ check: 'APPROVAL_THRESHOLD', code: 'RISK_APPROVAL_THRESHOLD', category: 'RISK', status: 'NOT_CONFIGURED', severity: 'LOW', observed: usd(value), limit: null, unit: 'USD', reason: 'No approval threshold configured.' }));
  else if (value === null) out.push(r({ check: 'APPROVAL_THRESHOLD', code: 'RISK_APPROVAL_THRESHOLD', category: 'RISK', status: 'UNCERTAIN', effect: 'REQUIRE_APPROVAL', severity: 'MEDIUM', observed: null, limit: t, unit: 'USD', reason: 'The transaction value is unknown, so a human must review it.' }));
  else { const over = value > dec(t); out.push(r({ check: 'APPROVAL_THRESHOLD', code: 'RISK_APPROVAL_THRESHOLD', category: 'RISK', status: over ? 'FAILED' : 'PASSED', effect: over ? 'REQUIRE_APPROVAL' : 'NONE', severity: 'MEDIUM', observed: usd(value), limit: t, unit: 'USD', reason: over ? `Transactions above ${t} USD need human approval.` : 'Below the approval threshold.' })); }

  return out;
}

export function assetName(k: string) { return k === SOL ? 'SOL' : k === WSOL_MINT ? 'wSOL' : short(k); }

// --------------------------------------------------------------------------------------- firewall

export function firewallChecks(ctx: Context, p: PolicyConfig): CheckResult[] {
  const S = p.security;
  const out: CheckResult[] = [];
  const sec = (x: Omit<CheckResult, 'category' | 'observed' | 'limit' | 'unit' | 'effect'> & Partial<Pick<CheckResult, 'observed' | 'limit' | 'unit' | 'effect'>>) => out.push(r({ category: 'SECURITY', observed: null, limit: null, unit: null, ...x }));
  const d = ctx.decoded;

  if (!d.complete) sec({ check: 'DECODE_COMPLETE', code: 'SEC_DECODE_INCOMPLETE', status: 'UNCERTAIN', effect: uncertainEffect(p), severity: 'HIGH', reason: d.issues.join('; ') });
  else sec({ check: 'DECODE_COMPLETE', code: 'SEC_DECODE_INCOMPLETE', status: 'PASSED', severity: 'LOW', reason: `${d.format} transaction, ${d.instructions.length} instruction(s), fully decoded.` });

  // the agent's own wallet must sign: otherwise this is not the agent's transaction
  if (!ctx.walletConfigured) sec({ check: 'AGENT_WALLET_SIGNER', code: 'SEC_WALLET_NOT_SIGNER', status: 'WARNING', severity: 'MEDIUM', reason: `No wallet is registered for this agent; the fee payer ${short(d.feePayer)} is analysed as the acting wallet.` });
  else if (!d.signers.includes(ctx.wallet)) sec({ check: 'AGENT_WALLET_SIGNER', code: 'SEC_WALLET_NOT_SIGNER', status: 'FAILED', effect: 'DENY', severity: 'HIGH', observed: d.signers.map(short).join(', '), reason: "The agent's wallet does not sign this transaction." });
  else sec({ check: 'AGENT_WALLET_SIGNER', code: 'SEC_WALLET_NOT_SIGNER', status: 'PASSED', severity: 'LOW', reason: "The agent's wallet signs this transaction." });

  // programs
  const allPrograms = [...new Set(ctx.allInstructions.map((i) => i.program))];
  const blocked = allPrograms.filter((x) => S.blockedPrograms.includes(x));
  if (blocked.length) sec({ check: 'BLOCKED_PROGRAMS', code: 'SEC_BLOCKED_PROGRAM', status: 'FAILED', effect: 'DENY', severity: 'CRITICAL', observed: blocked.join(', '), reason: `Blocked program invoked: ${blocked.map(name).join(', ')}.` });
  else sec({ check: 'BLOCKED_PROGRAMS', code: 'SEC_BLOCKED_PROGRAM', status: S.blockedPrograms.length ? 'PASSED' : 'NOT_CONFIGURED', severity: 'LOW', reason: S.blockedPrograms.length ? 'No blocked program is invoked.' : 'No blocked programs configured.' });
  if (S.allowedPrograms.length) {
    const notAllowed = d.programs.filter((x) => !INFRASTRUCTURE.has(x) && !S.allowedPrograms.includes(x));
    if (notAllowed.length) sec({ check: 'ALLOWED_PROGRAMS', code: 'SEC_PROGRAM_NOT_ALLOWED', status: 'FAILED', effect: 'DENY', severity: 'HIGH', observed: notAllowed.join(', '), reason: `Program not in the allowlist: ${notAllowed.map(name).join(', ')}.` });
    else sec({ check: 'ALLOWED_PROGRAMS', code: 'SEC_PROGRAM_NOT_ALLOWED', status: 'PASSED', severity: 'LOW', reason: 'Every top-level program is allowed.' });
  } else sec({ check: 'ALLOWED_PROGRAMS', code: 'SEC_PROGRAM_NOT_ALLOWED', status: 'NOT_CONFIGURED', severity: 'LOW', reason: 'No program allowlist: any program not blocked passes this rule.' });

  // unknown instructions (top level; inner ones of recognised swaps are the routed AMMs)
  const unknownTop = d.instructions.filter((i) => i.effects.some((e) => e.kind === 'UNKNOWN'));
  if (unknownTop.length) {
    const reasons = unknownTop.map((i) => `#${i.index} ${name(i.program)}: ${(i.effects[0] as any).reason}`).join('; ');
    const effect: Effect = S.unknownInstructions === 'ALLOW' ? 'NONE' : S.unknownInstructions;
    sec({ check: 'UNKNOWN_INSTRUCTIONS', code: 'SEC_UNKNOWN_INSTRUCTION', status: effect === 'NONE' ? 'WARNING' : 'FAILED', effect, severity: 'HIGH', observed: String(unknownTop.length), reason: `Instructions Intercept cannot interpret: ${reasons}.` });
  } else sec({ check: 'UNKNOWN_INSTRUCTIONS', code: 'SEC_UNKNOWN_INSTRUCTION', status: 'PASSED', severity: 'LOW', reason: 'Every instruction is interpreted.' });

  // recipients
  const recips = ctx.transfers;
  const unresolved = recips.filter((t) => !t.recipientResolved);
  const blockedR = recips.filter((t) => t.recipient && S.blockedRecipients.includes(t.recipient));
  const strangers = recips.filter((t) => t.recipient && !S.allowedRecipients.includes(t.recipient));
  if (blockedR.length) sec({ check: 'BLOCKED_RECIPIENTS', code: 'SEC_BLOCKED_RECIPIENT', status: 'FAILED', effect: 'DENY', severity: 'CRITICAL', observed: blockedR.map((t) => t.recipient).join(', '), reason: 'Funds would go to a blocked address.' });
  else sec({ check: 'BLOCKED_RECIPIENTS', code: 'SEC_BLOCKED_RECIPIENT', status: S.blockedRecipients.length ? 'PASSED' : 'NOT_CONFIGURED', severity: 'LOW', reason: S.blockedRecipients.length ? 'No blocked recipient.' : 'No blocked recipients configured.' });
  if (!recips.length) sec({ check: 'RECIPIENTS', code: 'SEC_UNKNOWN_RECIPIENT', status: 'NOT_APPLICABLE', severity: 'LOW', reason: 'No transfer leaves the agent wallet.' });
  else if (unresolved.length) sec({ check: 'RECIPIENTS', code: 'SEC_UNKNOWN_RECIPIENT', status: 'UNCERTAIN', effect: uncertainEffect(p), severity: 'HIGH', observed: unresolved.map((t) => t.from).join(', '), reason: 'The owner of a destination token account could not be determined.' });
  else if (S.allowedRecipients.length && strangers.length) sec({ check: 'RECIPIENTS', code: 'SEC_RECIPIENT_NOT_ALLOWED', status: 'FAILED', effect: 'DENY', severity: 'HIGH', observed: strangers.map((t) => t.recipient).join(', '), reason: 'Recipient not in the allowlist.' });
  else if (!S.allowedRecipients.length && S.blockUnknownRecipients) sec({ check: 'RECIPIENTS', code: 'SEC_UNKNOWN_RECIPIENT', status: 'FAILED', effect: 'DENY', severity: 'HIGH', observed: recips.map((t) => t.recipient).join(', '), reason: 'Transfers to other addresses are blocked and no recipient is allowlisted.' });
  else sec({ check: 'RECIPIENTS', code: 'SEC_UNKNOWN_RECIPIENT', status: 'PASSED', severity: 'LOW', reason: S.allowedRecipients.length ? 'Every recipient is allowlisted.' : 'Transfers to other addresses are permitted by policy.' });

  // mints
  const mints = new Set<string>();
  for (const a of [...ctx.outflows.values(), ...ctx.inflows.values()]) if (a.asset !== SOL) mints.add(a.mint);
  for (const t of recips) if (t.mint) mints.add(t.mint);
  const restricted = [...mints].filter((m) => S.restrictedMints.includes(m));
  if (restricted.length) sec({ check: 'RESTRICTED_MINTS', code: 'SEC_RESTRICTED_MINT', status: 'FAILED', effect: 'DENY', severity: 'HIGH', observed: restricted.join(', '), reason: 'A restricted token is involved.' });
  else sec({ check: 'RESTRICTED_MINTS', code: 'SEC_RESTRICTED_MINT', status: S.restrictedMints.length ? 'PASSED' : 'NOT_CONFIGURED', severity: 'LOW', reason: S.restrictedMints.length ? 'No restricted token.' : 'No restricted tokens configured.' });
  if (S.allowedMints.length) {
    const off = [...mints].filter((m) => !S.allowedMints.includes(m));
    if (off.length) sec({ check: 'ALLOWED_MINTS', code: 'SEC_MINT_NOT_ALLOWED', status: 'FAILED', effect: 'DENY', severity: 'HIGH', observed: off.join(', '), reason: 'A token outside the allowlist is involved.' });
    else if (ctx.flowSource === 'decoded' && ctx.decoded.unknownPrograms.length) sec({ check: 'ALLOWED_MINTS', code: 'SEC_MINT_NOT_ALLOWED', status: 'UNCERTAIN', effect: uncertainEffect(p), severity: 'HIGH', reason: 'Without simulation the tokens moved by unrecognised programs are unknown.' });
    else sec({ check: 'ALLOWED_MINTS', code: 'SEC_MINT_NOT_ALLOWED', status: 'PASSED', severity: 'LOW', reason: 'Every token involved is allowlisted.' });
  } else sec({ check: 'ALLOWED_MINTS', code: 'SEC_MINT_NOT_ALLOWED', status: 'NOT_CONFIGURED', severity: 'LOW', reason: 'No token allowlist.' });

  // delegates and authorities
  const approvals = ctx.effects.filter((e) => e.effect.kind === 'TOKEN_APPROVE');
  if (approvals.length && !S.allowDelegateApprovals) sec({ check: 'DELEGATE_APPROVALS', code: 'SEC_DELEGATE_APPROVAL', status: 'FAILED', effect: 'DENY', severity: 'CRITICAL', observed: approvals.map((a) => (a.effect as any).delegate).join(', '), reason: 'The transaction grants a token delegate the right to move funds.' });
  else sec({ check: 'DELEGATE_APPROVALS', code: 'SEC_DELEGATE_APPROVAL', status: approvals.length ? 'WARNING' : 'PASSED', severity: approvals.length ? 'MEDIUM' : 'LOW', reason: approvals.length ? 'Delegate approval permitted by policy.' : 'No delegate approval.' });
  const authority = ctx.effects.filter((e) => e.effect.kind === 'SET_AUTHORITY' || e.effect.kind === 'ACCOUNT_ASSIGN');
  if (authority.length && !S.allowAuthorityChanges) sec({ check: 'AUTHORITY_CHANGES', code: 'SEC_AUTHORITY_CHANGE', status: 'FAILED', effect: 'DENY', severity: 'CRITICAL', observed: authority.map((a) => a.effect.kind === 'SET_AUTHORITY' ? `${(a.effect as any).authorityType} → ${(a.effect as any).newAuthority ?? 'none'}` : `assign → ${(a.effect as any).newOwnerProgram}`).join('; '), reason: 'The transaction changes an account authority or owner.' });
  else sec({ check: 'AUTHORITY_CHANGES', code: 'SEC_AUTHORITY_CHANGE', status: authority.length ? 'WARNING' : 'PASSED', severity: authority.length ? 'MEDIUM' : 'LOW', reason: authority.length ? 'Authority change permitted by policy.' : 'No authority change.' });

  // simulation
  const sim = ctx.simulation;
  if (!sim) sec({ check: 'SIMULATION', code: 'SEC_SIMULATION_UNAVAILABLE', status: S.requireSimulation ? 'UNCERTAIN' : 'NOT_CONFIGURED', effect: S.requireSimulation ? uncertainEffect(p) : 'NONE', severity: 'HIGH', reason: 'Simulation was not run.' });
  else if (sim.status === 'FAILED') sec({ check: 'SIMULATION', code: 'SEC_SIMULATION_FAILED', status: 'FAILED', effect: 'DENY', severity: 'HIGH', observed: JSON.stringify(sim.error), reason: `The transaction fails in simulation at slot ${sim.slot}.` });
  else if (sim.status === 'UNAVAILABLE') sec({ check: 'SIMULATION', code: 'SEC_SIMULATION_UNAVAILABLE', status: S.requireSimulation ? 'UNCERTAIN' : 'WARNING', effect: S.requireSimulation ? uncertainEffect(p) : 'NONE', severity: 'HIGH', reason: `Simulation unavailable: ${sim.reason}.` });
  else sec({ check: 'SIMULATION', code: 'SEC_SIMULATION_FAILED', status: 'PASSED', severity: 'LOW', observed: `${sim.unitsConsumed ?? '?'} CU`, reason: `Simulated successfully at slot ${sim.slot}.` });

  // simulated outflows not explained by decoded instructions
  if (sim?.status === 'SUCCESS') {
    const problems: string[] = [];
    const hasSwap = ctx.effects.some((e) => e.effect.kind === 'SWAP');
    const solOut = ctx.outflows.get(SOL)?.raw ?? 0n;
    let explainedSol = 0n;
    for (const { effect: e } of ctx.effects) {
      if (e.kind === 'SOL_TRANSFER' && e.from === ctx.wallet) explainedSol += BigInt(e.lamports);
      if (e.kind === 'CREATE_ACCOUNT' && e.from === ctx.wallet) explainedSol += BigInt(e.lamports);
      if (e.kind === 'ATA_CREATE' && e.payer === ctx.wallet) explainedSol += 2_500_000n; // token account rent (Token-2022 accounts can be larger)
    }
    const feeAllowance = 5_000n * BigInt(d.signers.length) + 2_000_000n; // signature fees + priority fees
    if (solOut > explainedSol + feeAllowance && !(hasSwap && ctx.inflows.size)) problems.push(`SOL balance falls by ${solOut} lamports, ${solOut - explainedSol} more than the decoded transfers and fees explain`);
    for (const [k, a] of ctx.outflows) {
      if (k === SOL) continue;
      let explained = 0n;
      for (const t of ctx.transfers) if (t.kind === 'TOKEN' && t.mint === k && /^\d+$/.test(t.raw)) explained += BigInt(t.raw);
      for (const { effect: e } of ctx.effects) if (e.kind === 'TOKEN_BURN' && e.mint === k) explained += BigInt(e.amount);
      if (!hasSwap && a.raw > explained) problems.push(`${assetName(k)} balance falls by ${a.raw} base units, ${a.raw - explained} unexplained`);
    }
    if (problems.length) sec({ check: 'UNEXPECTED_OUTFLOWS', code: 'SEC_UNEXPECTED_OUTFLOW', status: 'FAILED', effect: 'DENY', severity: 'CRITICAL', reason: problems.join('; ') + '.' });
    else sec({ check: 'UNEXPECTED_OUTFLOWS', code: 'SEC_UNEXPECTED_OUTFLOW', status: 'PASSED', severity: 'LOW', reason: 'Every simulated balance reduction is explained by the decoded instructions.' });
  } else sec({ check: 'UNEXPECTED_OUTFLOWS', code: 'SEC_UNEXPECTED_OUTFLOW', status: S.requireSimulation ? 'UNCERTAIN' : 'WARNING', effect: S.requireSimulation ? uncertainEffect(p) : 'NONE', severity: 'HIGH', reason: 'Asset movements could not be measured without a successful simulation.' });

  return out;
}

// ------------------------------------------------------------------------------------------ system

export function systemChecks(a: AgentState): CheckResult[] {
  const out: CheckResult[] = [];
  const s = (x: Omit<CheckResult, 'category' | 'observed' | 'limit' | 'unit' | 'effect'> & { effect?: Effect }) => out.push(r({ category: 'SYSTEM', observed: null, limit: null, unit: null, ...x }));
  if (a.orgEmergencyStop) s({ check: 'EMERGENCY_STOP', code: 'SYS_EMERGENCY_STOP', status: 'FAILED', effect: 'DENY', severity: 'CRITICAL', reason: 'The organization emergency stop is active: every transaction is denied.' });
  if (a.status === 'PAUSED') s({ check: 'AGENT_STATUS', code: 'SYS_AGENT_PAUSED', status: 'FAILED', effect: 'DENY', severity: 'HIGH', reason: 'The agent is paused.' });
  if (a.status === 'REVOKED') s({ check: 'AGENT_STATUS', code: 'SYS_AGENT_REVOKED', status: 'FAILED', effect: 'DENY', severity: 'CRITICAL', reason: 'The agent is revoked.' });
  if (a.mode === 'ENFORCED_EXECUTION' && !a.walletVerified) s({ check: 'WALLET_VERIFIED', code: 'SYS_WALLET_UNVERIFIED', status: 'FAILED', effect: 'DENY', severity: 'HIGH', reason: 'Enforced execution requires a verified agent wallet.' });
  return out;
}

export function decide(checks: CheckResult[]): { decision: Decision; reasons: { code: string; check: string; effect: Effect; message: string }[] } {
  const effective = checks.filter((c) => c.effect !== 'NONE');
  const decision: Decision = effective.some((c) => c.effect === 'DENY') ? 'DENY' : effective.some((c) => c.effect === 'REQUIRE_APPROVAL') ? 'REQUIRE_APPROVAL' : 'ALLOW';
  const order = { DENY: 0, REQUIRE_APPROVAL: 1, NONE: 2 } as const;
  const reasons = effective.sort((a, b) => order[a.effect] - order[b.effect]).map((c) => ({ code: c.code, check: c.check, effect: c.effect, message: c.reason }));
  return { decision, reasons };
}

export { SUPPORTED };
