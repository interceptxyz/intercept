/**
 * Turns the recorded execution of a landed transaction (getTransaction meta) into the same shape as
 * a simulation result, so the engine can judge what a transaction actually did.
 */
import type { VersionedTransactionResponse } from '@solana/web3.js';
import { decodeInner } from '../solana/decode';
import type { Simulation } from '../solana/simulate';
import { primeDecimals } from './context';

export function observedExecution(t: VersionedTransactionResponse) {
  const meta = t.meta!;
  return (decoded: { accountKeys: string[] }): Simulation => {
    const keys = decoded.accountKeys;
    const solChanges = keys.map((account, k) => ({ account, pre: String(meta.preBalances[k] ?? 0), post: String(meta.postBalances[k] ?? 0), delta: String((meta.postBalances[k] ?? 0) - (meta.preBalances[k] ?? 0)) })).filter((c) => c.delta !== '0');
    const tokenOwners: Record<string, { owner: string; mint: string }> = {};
    const tok = new Map<number, { pre: bigint; post: bigint; mint: string; owner: string; program: string }>();
    for (const [list, field] of [[meta.preTokenBalances ?? [], 'pre'], [meta.postTokenBalances ?? [], 'post']] as const) {
      for (const b of list) {
        const e = tok.get(b.accountIndex) ?? { pre: 0n, post: 0n, mint: b.mint, owner: b.owner ?? '', program: b.programId ?? '' };
        e[field] = BigInt(b.uiTokenAmount.amount);
        primeDecimals(b.mint, b.uiTokenAmount.decimals);
        tok.set(b.accountIndex, e);
        if (b.owner) tokenOwners[keys[b.accountIndex]] = { owner: b.owner, mint: b.mint };
      }
    }
    const tokenChanges = [...tok].filter(([, e]) => e.pre !== e.post).map(([k, e]) => ({ account: keys[k], mint: e.mint, owner: e.owner, program: e.program, pre: e.pre.toString(), post: e.post.toString(), delta: (e.post - e.pre).toString(), created: false, closed: false }));
    return {
      status: meta.err ? 'FAILED' : 'SUCCESS', reason: meta.err ? `failed onchain: ${JSON.stringify(meta.err)}` : 'recorded execution', slot: t.slot, error: meta.err ?? null,
      logs: (meta.logMessages ?? []).slice(0, 80), unitsConsumed: meta.computeUnitsConsumed ?? null,
      innerInstructions: decodeInner(meta.innerInstructions as any, keys), solChanges, tokenChanges, tokenOwners, trackedAccounts: keys.length, replacedBlockhash: false,
    };
  };
}
