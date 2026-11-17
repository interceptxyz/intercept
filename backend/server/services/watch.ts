/**
 * Wallet watchlist. Each organization picks wallets to follow; every new transaction of a watched
 * wallet is read from the chain and judged by the engine on its recorded execution (balances and
 * inner instructions), with the chosen policy. Alert rules decide which events raise an alert
 * (Alerts page + webhooks).
 *
 * Scheduling: tick() checks due wallets. It runs after API traffic (at most every 30 s, through
 * waitUntil) and from POST /v1/internal/tick (cron with CRON_SECRET).
 */
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import { Db, one, q } from '../db';
import { bad, dec, decStr, isBase58Address, newId, notFound } from '../lib/util';
import { PolicyConfig, parsePolicy } from '../policy/schema';
import { buildContext } from '../engine/context';
import { observedExecution } from '../engine/observed';
import { decide, firewallChecks, riskChecks } from '../engine/checks';
import { Network, connection, rpc } from '../solana/rpc';
import { PROGRAMS, PROGRAM_NAMES } from '../solana/programs';
import { FEED_POLICY } from './feed';
import { alert } from './webhooks';

const usd = z.string().regex(/^\d{1,15}(\.\d{1,9})?$/);
export const rulesSchema = z.object({
  outgoing: z.boolean().default(true),          // any transaction moving value out of the wallet
  incoming: z.boolean().default(false),         // any transaction bringing value in
  minValueUsd: usd.nullable().default(null),    // activity alerts only above this value
  onDeny: z.boolean().default(true),            // the policy would deny it
  onApproval: z.boolean().default(true),        // the policy would require approval
  codes: z.array(z.string().regex(/^(SEC|RISK|SYS)_[A-Z_]+$/)).max(30).default([]), // always alert on these rule codes
  failed: z.boolean().default(false),           // transaction failed onchain
}).strict();
export type Rules = z.infer<typeof rulesSchema>;

const MAX_PER_RUN = 10;
const CRITICAL = new Set(['SEC_DELEGATE_APPROVAL', 'SEC_AUTHORITY_CHANGE', 'SEC_UNEXPECTED_OUTFLOW', 'SEC_BLOCKED_RECIPIENT', 'SEC_BLOCKED_PROGRAM']);
const label = (programs: string[]) => programs.filter((p) => p !== PROGRAMS.COMPUTE_BUDGET).map((p) => PROGRAM_NAMES[p] ?? `${p.slice(0, 4)}…${p.slice(-4)}`).slice(0, 5);

export interface WatchEvent { direction: 'OUTGOING' | 'INCOMING' | 'INTERNAL'; decision: string | null; reasons: string[]; valueOut: string | null; valueIn: string | null; failed: boolean }

/** Pure: which alert (if any) an event raises under the rules. */
export function alertFor(e: WatchEvent, r: Rules): { severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; why: string[] } | null {
  const why: string[] = [];
  const codes = e.reasons.filter((c) => r.codes.includes(c));
  if (codes.length) why.push(`rule ${codes.join(', ')}`);
  if (r.onDeny && e.decision === 'DENY') why.push('the policy would deny it');
  if (r.onApproval && e.decision === 'REQUIRE_APPROVAL') why.push('the policy would require approval');
  if (r.failed && e.failed) why.push('it failed onchain');
  const v = e.direction === 'OUTGOING' ? e.valueOut : e.direction === 'INCOMING' ? e.valueIn : null;
  const aboveMin = r.minValueUsd === null || (v !== null && dec(v) >= dec(r.minValueUsd));
  if (aboveMin && ((r.outgoing && e.direction === 'OUTGOING') || (r.incoming && e.direction === 'INCOMING'))) why.push(`${e.direction.toLowerCase()} ${v !== null ? '$' + v : 'transaction'}`);
  if (!why.length) return null;
  const severity = e.reasons.some((c) => CRITICAL.has(c)) && (e.decision === 'DENY' || codes.length) ? 'CRITICAL' : e.decision === 'DENY' ? 'HIGH' : e.decision === 'REQUIRE_APPROVAL' || codes.length ? 'MEDIUM' : 'LOW';
  return { severity, why };
}

async function policyFor(db: Db, w: any): Promise<PolicyConfig> {
  if (!w.policy_id) return FEED_POLICY;
  const v = await one(db, `SELECT v.config FROM policies p JOIN policy_versions v ON v.policy_id = p.id AND v.version = p.current_version WHERE p.id = $1 AND p.org_id = $2`, [w.policy_id, w.org_id]);
  const p = v ? parsePolicy(v.config) : null;
  return p && p.ok ? p.config : FEED_POLICY;
}

/** Reads and judges new transactions of one wallet. Returns the number of new events. */
export async function refreshWallet(db: Db, w: any, conn: Connection = connection(w.network as Network)): Promise<number> {
  try {
    const sigs = (await rpc('getSignaturesForAddress', () => conn.getSignaturesForAddress(new PublicKey(w.address), { limit: 25, ...(w.last_signature ? { until: w.last_signature } : {}) }, 'confirmed')));
    const first = !w.last_signature;
    // first run: show recent history without alerting; later runs: newest MAX_PER_RUN, oldest first
    const batch = sigs.slice(0, first ? 5 : MAX_PER_RUN).reverse();
    const policy = await policyFor(db, w);
    let n = 0;
    for (const s of batch) {
      const t = await rpc('getTransaction', () => conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
      if (!t?.meta) continue;
      const ctx = await buildContext(new VersionedTransaction(t.transaction.message as any), { conn, network: w.network, wallet: w.address, runSimulation: false, observed: observedExecution(t) });
      const signs = ctx.decoded.signers.includes(w.address);
      let inUsd: bigint | null = 0n;
      for (const a of ctx.inflows.values()) inUsd = a.usd === null || inUsd === null ? null : inUsd + a.usd;
      const hasOut = [...ctx.outflows.values()].some((a) => a.asset !== 'SOL' || a.raw > 50_000n); // ignore fee-only SOL changes
      const direction: WatchEvent['direction'] = signs && hasOut ? 'OUTGOING' : ctx.inflows.size ? 'INCOMING' : 'INTERNAL';
      let decision: string | null = null, reasons: string[] = [];
      if (signs) {
        const checks = [...firewallChecks(ctx, policy), ...riskChecks(ctx, policy, { dailySpendUsd: 0n, protocolSpendUsd: {} })];
        const d = decide(checks);
        decision = d.decision; reasons = d.reasons.map((r) => r.code);
      }
      const ev: WatchEvent = { direction, decision, reasons, valueOut: ctx.valueUsd === null ? null : decStr(ctx.valueUsd, 2), valueIn: inUsd === null ? null : decStr(inUsd, 2), failed: !!t.meta.err };
      const summary = {
        kinds: [...new Set(ctx.allInstructions.flatMap((i) => i.effects.map((e) => e.kind)).filter((k) => !['COMPUTE_BUDGET', 'MEMO', 'NOOP'].includes(k)))].slice(0, 6),
        programs: label(ctx.decoded.programs), failed: ev.failed,
        out: [...ctx.outflows.values()].map((a) => ({ asset: a.asset === 'SOL' ? 'SOL' : a.mint, amount: a.units === null ? null : decStr(a.units, 6), usd: a.usd === null ? null : decStr(a.usd, 2) })),
        in: [...ctx.inflows.values()].map((a) => ({ asset: a.asset === 'SOL' ? 'SOL' : a.mint, amount: a.units === null ? null : decStr(a.units, 6), usd: a.usd === null ? null : decStr(a.usd, 2) })),
      };
      const id = newId('wev');
      const ins = await one(db, `INSERT INTO watch_events(id, org_id, wallet_id, signature, slot, block_time, direction, decision, reasons, value_out_usd, value_in_usd, summary)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (wallet_id, signature) DO NOTHING RETURNING id`,
        [id, w.org_id, w.id, s.signature, t.slot, t.blockTime ? new Date(t.blockTime * 1000) : null, direction, decision, reasons, ev.valueOut, ev.valueIn, JSON.stringify(summary)]);
      if (!ins) continue;
      n++;
      const a = first ? null : alertFor(ev, rulesSchema.parse(w.rules));
      if (a) {
        const created = await alert(db, { orgId: w.org_id, type: decision === 'DENY' ? 'WALLET_POLICY_VIOLATION' : 'WALLET_ACTIVITY', severity: a.severity, message: `${w.label}: ${a.why.join(' · ')}${reasons.length ? ` (${reasons.slice(0, 3).join(', ')})` : ''}` });
        await q(db, 'UPDATE alerts SET watched_wallet_id = $2, signature = $3 WHERE id = $1', [created.id, w.id, s.signature]);
        await q(db, 'UPDATE watch_events SET alerted = true WHERE id = $1', [id]);
      }
    }
    await q(db, `UPDATE watched_wallets SET last_signature = COALESCE($2, last_signature), last_checked_at = now(), last_error = NULL,
      last_activity_at = CASE WHEN $3 > 0 THEN now() ELSE last_activity_at END WHERE id = $1`, [w.id, sigs[0]?.signature ?? null, n]);
    return n;
  } catch (e: any) {
    await q(db, 'UPDATE watched_wallets SET last_checked_at = now(), last_error = $2 WHERE id = $1', [w.id, String(e.message ?? e).slice(0, 300)]);
    return 0;
  }
}

/** Checks wallets not checked in the last minute, within a time budget. */
export async function tick(db: Db, budgetMs = 20_000, everyMs = 30_000): Promise<{ wallets: number; events: number }> {
  const claim = await one(db, `INSERT INTO kv_state(key, value, updated_at) VALUES ('watch_tick', '', now())
    ON CONFLICT (key) DO UPDATE SET updated_at = now() WHERE kv_state.updated_at < now() - ($1 || ' milliseconds')::interval RETURNING key`, [String(everyMs)]);
  if (!claim) return { wallets: 0, events: 0 };
  const t0 = Date.now();
  const due = await q(db, `SELECT * FROM watched_wallets WHERE paused = false AND (last_checked_at IS NULL OR last_checked_at < now() - interval '60 seconds') ORDER BY last_checked_at NULLS FIRST LIMIT 50`);
  let wallets = 0, events = 0;
  for (const w of due) {
    if (Date.now() - t0 > budgetMs) break;
    events += await refreshWallet(db, w);
    wallets++;
  }
  return { wallets, events };
}

export const walletView = (w: any) => ({
  id: w.id, address: w.address, label: w.label, network: w.network, policyId: w.policy_id, rules: w.rules, paused: w.paused,
  lastCheckedAt: w.last_checked_at, lastActivityAt: w.last_activity_at, lastError: w.last_error, createdAt: w.created_at,
  events24h: w.events_24h ?? undefined, alerts24h: w.alerts_24h ?? undefined,
});

export async function addWallet(db: Db, orgId: string, userId: string, b: { address: string; label: string; network: Network; policyId: string | null; rules: unknown }) {
  if (!isBase58Address(b.address)) throw bad('INVALID_ADDRESS', 'Not a valid wallet address.');
  const rules = rulesSchema.safeParse(b.rules ?? {});
  if (!rules.success) throw bad('INVALID_RULES', 'Invalid alert rules.', rules.error.issues);
  const count = await one(db, 'SELECT count(*)::int n FROM watched_wallets WHERE org_id = $1', [orgId]);
  if (count!.n >= 50) throw bad('WALLET_LIMIT', 'At most 50 watched wallets per organization.');
  if (b.policyId && !(await one(db, 'SELECT 1 FROM policies WHERE id = $1 AND org_id = $2 AND archived_at IS NULL', [b.policyId, orgId]))) throw notFound('Policy');
  const id = newId('wal');
  try {
    return await one(db, `INSERT INTO watched_wallets(id, org_id, address, label, network, policy_id, rules, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, orgId, b.address, b.label, b.network, b.policyId, JSON.stringify(rules.data), userId]);
  } catch (e: any) {
    if (e.code === '23505') throw bad('ALREADY_WATCHED', 'This wallet is already watched on this network.');
    throw e;
  }
}
