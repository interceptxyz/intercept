/**
 * Builds the evaluation context from the transaction bytes and the chain: decoded instructions,
 * simulation, the agent wallet's holdings, the asset flows, prices and recipients.
 */
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Dec, dec, decStr, fromBaseUnits, mulDec } from '../lib/util';
import { getPrices, isFresh, Price } from '../market/prices';
import { DecodedInstruction, DecodedTransaction, Effect, decodeTransaction } from '../solana/decode';
import { PROGRAMS, WSOL_MINT } from '../solana/programs';
import { Network, RpcError, TokenAccountState, parseMintDecimals, parseTokenAccount, rpc, walletTokenAccounts } from '../solana/rpc';
import { Simulation, simulate } from '../solana/simulate';

export const SOL = 'SOL';
export const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU']);

export interface AssetAmount { asset: string; mint: string; raw: bigint; decimals: number | null; units: Dec | null; usd: Dec | null; price: Price | null; fresh: boolean }
export interface Transfer { kind: 'SOL' | 'TOKEN' | 'CLOSE'; from: string; recipient: string | null; recipientResolved: boolean; mint: string | null; raw: string; stackHeight: number; instruction: number }

export interface Context {
  network: Network;
  wallet: string;                    // the acting wallet (agent wallet, or fee payer when none is configured)
  walletConfigured: boolean;
  decoded: DecodedTransaction;
  simulation: Simulation | null;
  allInstructions: DecodedInstruction[];
  effects: { effect: Effect; ix: DecodedInstruction; inSwap: boolean }[];
  holdingsPre: Map<string, AssetAmount> | null;   // null = portfolio unavailable
  outflows: Map<string, AssetAmount>;
  inflows: Map<string, AssetAmount>;
  flowSource: 'simulation' | 'decoded';
  transfers: Transfer[];
  valueUsd: Dec | null;              // total outflow value; null = not fully priceable
  valueIssues: string[];
  prices: Map<string, Price>;
  priceErrors: string[];
  currentSlot: number | null;
  rpcIssues: string[];
}

const mintDecimalsCache = new Map<string, number>();

async function mintDecimals(conn: Connection, mints: string[], issues: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>([[WSOL_MINT, 9]]);
  const need = [...new Set(mints)].filter((m) => { const c = mintDecimalsCache.get(m); if (c !== undefined) out.set(m, c); return c === undefined && m !== WSOL_MINT; });
  if (!need.length) return out;
  try {
    const infos = await rpc('getMultipleAccountsInfo(mints)', () => conn.getMultipleAccountsInfo(need.map((m) => new PublicKey(m)), 'confirmed'));
    infos.forEach((info, i) => {
      const d = info ? parseMintDecimals(info.owner.toBase58(), Buffer.from(info.data)) : null;
      if (d !== null) { mintDecimalsCache.set(need[i], d); out.set(need[i], d); }
    });
  } catch (e: any) { issues.push(e.message); }
  return out;
}

export async function buildContext(vtx: VersionedTransaction, opts: { conn: Connection; network: Network; wallet: string | null; runSimulation: boolean; observed?: (decoded: DecodedTransaction) => Simulation }): Promise<Context> {
  const { conn, network } = opts;
  const rpcIssues: string[] = [];
  const decoded = await decodeTransaction(vtx, conn);
  const wallet = opts.wallet ?? decoded.feePayer;

  // agent holdings (pre-state)
  let walletTokens: TokenAccountState[] = [];
  let lamports: bigint | null = null;
  try {
    walletTokens = await walletTokenAccounts(conn, wallet);
    lamports = BigInt(await rpc('getBalance', () => conn.getBalance(new PublicKey(wallet), 'confirmed')));
  } catch (e: any) { rpcIssues.push(e.message); }
  const portfolioOk = lamports !== null;

  // `observed` replaces simulation with the recorded execution of an already-landed transaction
  const simulation = opts.observed ? opts.observed(decoded) : opts.runSimulation ? await simulate(conn, vtx, decoded, wallet, walletTokens) : null;
  let currentSlot = simulation?.slot ?? null;
  if (currentSlot === null) { try { currentSlot = await rpc('getSlot', () => conn.getSlot('confirmed')); } catch (e: any) { rpcIssues.push(e.message); } }

  const inner = simulation?.status === 'SUCCESS' ? simulation.innerInstructions : [];
  const allInstructions = [...decoded.instructions, ...inner];
  const swapTop = new Set(decoded.instructions.filter((i) => i.effects.some((e) => e.kind === 'SWAP')).map((i) => i.index));
  const effects = allInstructions.flatMap((ix) => ix.effects.map((effect) => ({ effect, ix, inSwap: ix.stackHeight > 1 && swapTop.has(ix.index) })));

  // token account → owner/mint, from every source available
  const tokenInfo = new Map<string, { owner: string; mint: string }>();
  for (const t of walletTokens) tokenInfo.set(t.address, { owner: t.owner, mint: t.mint });
  for (const [a, v] of Object.entries(simulation?.tokenOwners ?? {})) tokenInfo.set(a, v);
  for (const { effect } of effects) if (effect.kind === 'ATA_CREATE') tokenInfo.set(effect.account, { owner: effect.wallet, mint: effect.mint });
  const unresolved = new Set<string>();
  for (const { effect } of effects) {
    if (effect.kind === 'TOKEN_TRANSFER' && !tokenInfo.has(effect.destination)) unresolved.add(effect.destination);
    if (effect.kind === 'TOKEN_TRANSFER' && !tokenInfo.has(effect.source)) unresolved.add(effect.source);
  }
  if (unresolved.size) {
    try {
      const list = [...unresolved].filter((a) => !a.startsWith('#'));
      const infos = await rpc('getMultipleAccountsInfo(tokens)', () => conn.getMultipleAccountsInfo(list.map((a) => new PublicKey(a)), 'confirmed'));
      infos.forEach((info, i) => { const t = info ? parseTokenAccount(list[i], info.owner.toBase58(), Buffer.from(info.data)) : null; if (t) tokenInfo.set(list[i], { owner: t.owner, mint: t.mint }); });
    } catch (e: any) { rpcIssues.push(e.message); }
  }

  // transfers leaving the acting wallet
  const ownedToken = (acct: string) => tokenInfo.get(acct)?.owner === wallet;
  const transfers: Transfer[] = [];
  for (const { effect: e, ix, inSwap } of effects) {
    if (inSwap) continue; // movements inside a recognised swap are accounted by the simulation deltas
    if (e.kind === 'SOL_TRANSFER' && e.from === wallet && e.to !== wallet) transfers.push({ kind: 'SOL', from: e.from, recipient: e.to, recipientResolved: true, mint: null, raw: e.lamports, stackHeight: ix.stackHeight, instruction: ix.index });
    if (e.kind === 'TOKEN_TRANSFER' && (e.authority === wallet || ownedToken(e.source))) {
      const dst = tokenInfo.get(e.destination);
      if (dst?.owner === wallet) continue;
      transfers.push({ kind: 'TOKEN', from: e.source, recipient: dst?.owner ?? null, recipientResolved: !!dst, mint: e.mint ?? tokenInfo.get(e.source)?.mint ?? null, raw: e.amount, stackHeight: ix.stackHeight, instruction: ix.index });
    }
    if (e.kind === 'CLOSE_ACCOUNT' && (e.owner === wallet || ownedToken(e.account)) && e.destination !== wallet) transfers.push({ kind: 'CLOSE', from: e.account, recipient: e.destination, recipientResolved: true, mint: null, raw: 'rent', stackHeight: ix.stackHeight, instruction: ix.index });
  }

  // asset flows: simulation deltas when available, otherwise the decoded transfers
  const rawOut = new Map<string, bigint>(), rawIn = new Map<string, bigint>();
  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
  let flowSource: 'simulation' | 'decoded' = 'decoded';
  if (simulation?.status === 'SUCCESS') {
    flowSource = 'simulation';
    const sol = simulation.solChanges.find((c) => c.account === wallet);
    if (sol) { const d = BigInt(sol.delta); if (d < 0n) add(rawOut, SOL, -d); else add(rawIn, SOL, d); }
    for (const c of simulation.tokenChanges) {
      if (c.owner !== wallet) continue;
      const d = BigInt(c.delta);
      if (d < 0n) add(rawOut, c.mint, -d); else add(rawIn, c.mint, d);
    }
  } else {
    for (const t of transfers) {
      if (t.kind === 'SOL') add(rawOut, SOL, BigInt(t.raw));
      if (t.kind === 'TOKEN' && t.mint && /^\d+$/.test(t.raw)) add(rawOut, t.mint, BigInt(t.raw));
    }
  }

  // holdings before the transaction
  const rawHold = new Map<string, bigint>();
  if (portfolioOk) {
    rawHold.set(SOL, lamports!);
    for (const t of walletTokens) add(rawHold, t.mint, t.amount);
  }

  const mints = [...new Set([...rawOut.keys(), ...rawIn.keys(), ...rawHold.keys()].filter((m) => m !== SOL))];
  for (const { effect } of effects) if (effect.kind === 'TOKEN_TRANSFER' && effect.mint) mints.push(effect.mint);
  const decimals = await mintDecimals(conn, mints, rpcIssues);
  const { prices, errors: priceErrors } = await getPrices([WSOL_MINT, ...mints], network);

  const valueIssues: string[] = [];
  const amount = (asset: string, raw: bigint): AssetAmount => {
    const mint = asset === SOL ? WSOL_MINT : asset;
    const d = decimals.get(mint) ?? null;
    const price = prices.get(mint) ?? null;
    const fresh = price ? isFresh(price, currentSlot, network) : false;
    const units = d === null ? null : fromBaseUnits(raw, d);
    const usd = units !== null && price && fresh ? mulDec(units, price.usd) : null;
    return { asset, mint, raw, decimals: d, units, usd, price, fresh };
  };
  const toMap = (m: Map<string, bigint>) => new Map([...m].map(([k, v]) => [k, amount(k, v)]));
  const outflows = toMap(rawOut), inflows = toMap(rawIn);
  const holdingsPre = portfolioOk ? toMap(rawHold) : null;

  let valueUsd: Dec | null = 0n;
  for (const a of outflows.values()) {
    if (a.usd === null) {
      valueUsd = null;
      valueIssues.push(!a.price ? `no price for ${a.asset}` : !a.fresh ? `stale price for ${a.asset} (slot ${a.price.slot}, current ${currentSlot})` : `unknown decimals for ${a.asset}`);
    } else if (valueUsd !== null) valueUsd += a.usd;
  }
  if (flowSource === 'decoded') {
    if (!decoded.complete) { valueUsd = null; valueIssues.push('transaction not fully decoded'); }
    if (decoded.unknownPrograms.length) valueIssues.push('value read from decoded instructions only; unrecognised programs may move more');
    if (transfers.some((t) => t.kind === 'TOKEN' && !t.mint)) { valueUsd = null; valueIssues.push('token transfer with unknown mint'); }
  }

  return { network, wallet, walletConfigured: !!opts.wallet, decoded, simulation, allInstructions, effects, holdingsPre, outflows, inflows, flowSource, transfers, valueUsd, valueIssues, prices, priceErrors, currentSlot, rpcIssues };
}

export const fmtUsd = (d: Dec | null) => (d === null ? null : decStr(d, 2));
export const ZERO = dec(0);
export { RpcError, PROGRAMS };
