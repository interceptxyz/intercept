/**
 * Runs the transaction through the cluster's simulator and measures what it would change.
 * Simulation describes one possible outcome at one slot; it is not a guarantee of execution.
 * Failures are reported as such and never replaced by a synthetic success.
 */
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { DecodedInstruction, DecodedTransaction, decodeInner } from './decode';
import { RpcError, TokenAccountState, parseTokenAccount, rpc } from './rpc';

export interface BalanceChange { account: string; pre: string; post: string; delta: string }
export interface TokenChange extends BalanceChange { mint: string; owner: string; program: string; created: boolean; closed: boolean }

export interface Simulation {
  status: 'SUCCESS' | 'FAILED' | 'UNAVAILABLE';
  reason: string | null;
  slot: number | null;
  error: unknown;
  logs: string[];
  unitsConsumed: number | null;
  innerInstructions: DecodedInstruction[];
  solChanges: BalanceChange[];
  tokenChanges: TokenChange[];
  /** pre-state owner of every tracked token account (also used to resolve transfer recipients) */
  tokenOwners: Record<string, { owner: string; mint: string }>;
  trackedAccounts: number;
  replacedBlockhash: boolean;
}

const MAX_TRACKED = 64;

export async function simulate(conn: Connection, vtx: VersionedTransaction, decoded: DecodedTransaction, wallet: string | null, walletTokens: TokenAccountState[]): Promise<Simulation> {
  const base: Simulation = { status: 'UNAVAILABLE', reason: null, slot: null, error: null, logs: [], unitsConsumed: null, innerInstructions: [], solChanges: [], tokenChanges: [], tokenOwners: {}, trackedAccounts: 0, replacedBlockhash: true };
  if (!decoded.complete) return { ...base, reason: 'address lookup tables could not be resolved' };

  // A transaction can only modify accounts it references, and the RPC caps the post-state request
  // at the number of account keys. So the tracked set is exactly the transaction's writable keys
  // (plus the wallet, which a valid agent transaction always references as signer).
  void walletTokens;
  const inTx = new Set(decoded.accountKeys);
  const addresses = [...new Set([...(wallet && inTx.has(wallet) ? [wallet] : []), ...decoded.writable].filter((a) => !a.startsWith('#') && inTx.has(a)))].slice(0, Math.min(MAX_TRACKED, decoded.accountKeys.length));
  try {
    const pre = await rpc('getMultipleAccountsInfo', () => conn.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)), 'confirmed'));
    const sim = await rpc('simulateTransaction', () => conn.simulateTransaction(vtx, {
      sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', innerInstructions: true,
      accounts: { encoding: 'base64', addresses },
    }));
    const v = sim.value;
    const out: Simulation = {
      ...base,
      status: v.err ? 'FAILED' : 'SUCCESS',
      reason: v.err ? `simulation failed: ${JSON.stringify(v.err)}` : null,
      slot: sim.context.slot,
      error: v.err ?? null,
      logs: (v.logs ?? []).slice(0, 80),
      unitsConsumed: v.unitsConsumed ?? null,
      innerInstructions: decodeInner((v as any).innerInstructions, decoded.accountKeys),
      trackedAccounts: addresses.length,
    };
    if (v.err) return out;
    const post = v.accounts ?? [];
    addresses.forEach((addr, i) => {
      const p = pre[i];
      const q = post[i] as any;
      const preLamports = BigInt(p?.lamports ?? 0);
      const postLamports = BigInt(q?.lamports ?? 0);
      if (preLamports !== postLamports) out.solChanges.push({ account: addr, pre: preLamports.toString(), post: postLamports.toString(), delta: (postLamports - preLamports).toString() });
      const preT = p ? parseTokenAccount(addr, p.owner.toBase58(), Buffer.from(p.data)) : null;
      const postT = q && q.data ? parseTokenAccount(addr, q.owner, Buffer.from(q.data[0], 'base64')) : null;
      const t = preT ?? postT;
      if (t) out.tokenOwners[addr] = { owner: t.owner, mint: t.mint };
      if (t && (preT?.amount ?? 0n) !== (postT?.amount ?? 0n)) {
        const a = preT?.amount ?? 0n, b = postT?.amount ?? 0n;
        out.tokenChanges.push({ account: addr, mint: t.mint, owner: t.owner, program: t.program, pre: a.toString(), post: b.toString(), delta: (b - a).toString(), created: !preT, closed: !postT });
      }
    });
    return out;
  } catch (e: any) {
    if (e instanceof RpcError) return { ...base, reason: `${e.code}: ${e.message}` };
    return { ...base, reason: `simulation could not run: ${String(e.message ?? e).slice(0, 200)}` };
  }
}
