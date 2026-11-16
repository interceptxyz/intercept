/**
 * USD prices from the Jupiter Price API (v3). Each price carries the slot it was computed at;
 * a price older than MAX_PRICE_AGE_SLOTS behind the current slot is stale and treated as missing.
 * Prices are never invented: an unknown mint has no price and every dependent check is UNCERTAIN.
 *
 * Devnet assets have no market. Devnet SOL and Circle's devnet USDC are valued at the mainnet
 * reference price and flagged `reference: true`, so USD limits can be exercised on test agents.
 */
import { Dec, dec } from '../lib/util';
import { WSOL_MINT } from '../solana/programs';
import type { Network } from '../solana/rpc';

export interface Price { mint: string; usd: Dec; usdStr: string; slot: number; liquidityUsd: Dec | null; source: string; reference: boolean }

const PRICE_API = process.env.PRICE_API_URL ?? 'https://lite-api.jup.ag/price/v3';
export const MAX_PRICE_AGE_SLOTS = Number(process.env.MAX_PRICE_AGE_SLOTS ?? 300); // ~2 minutes
const DEVNET_REFERENCE: Record<string, string> = {
  [WSOL_MINT]: WSOL_MINT,
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Circle devnet USDC → USDC
};

const cache = new Map<string, { at: number; price: Price | null }>();
const CACHE_MS = 15_000;

/** Converts the JSON number text to an exact decimal (the API sends floats; we never compute with them). */
function numToDec(n: unknown): Dec | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const s = n.toString();
  if (/e/i.test(s)) {
    const [m, e] = s.split(/e/i);
    const exp = Number(e);
    const [i, f = ''] = m.split('.');
    const digits = i + f;
    const point = i.length + exp;
    const fixed = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
    return dec(fixed.replace(/^(\d*\.\d{0,9}).*$/, '$1').replace(/\.$/, ''));
  }
  return dec(s.replace(/^(\d+\.\d{0,9}).*$/, '$1'));
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
let fetcher: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }) as any;
export function setFetcher(f: Fetcher) { fetcher = f; cache.clear(); }

export async function getPrices(mints: string[], network: Network): Promise<{ prices: Map<string, Price>; errors: string[] }> {
  const want = [...new Set(mints)];
  const lookup = new Map<string, string>(); // requested mint -> mainnet mint to price
  for (const m of want) {
    if (network === 'devnet') { if (DEVNET_REFERENCE[m]) lookup.set(m, DEVNET_REFERENCE[m]); }
    else lookup.set(m, m);
  }
  const prices = new Map<string, Price>();
  const errors: string[] = [];
  const now = Date.now();
  const missing = [...new Set(lookup.values())].filter((m) => { const c = cache.get(m); return !c || now - c.at > CACHE_MS; });
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    try {
      const r = await fetcher(`${PRICE_API}?ids=${batch.join(',')}`);
      if (!r.ok) { errors.push(`price API HTTP ${r.status}`); continue; }
      const body = await r.json();
      for (const m of batch) {
        const p = body?.[m];
        const usd = p ? numToDec(p.usdPrice) : null;
        cache.set(m, { at: now, price: usd !== null && Number.isInteger(p.blockId) ? { mint: m, usd, usdStr: String(p.usdPrice), slot: p.blockId, liquidityUsd: numToDec(p.liquidity), source: 'jupiter-price-v3', reference: false } : null });
      }
    } catch (e: any) {
      errors.push(`price API unavailable: ${String(e.message ?? e).slice(0, 100)}`);
    }
  }
  for (const [m, src] of lookup) {
    const c = cache.get(src);
    if (c?.price) prices.set(m, { ...c.price, mint: m, reference: network === 'devnet', source: network === 'devnet' ? `${c.price.source} (mainnet reference for devnet asset)` : c.price.source });
  }
  return { prices, errors };
}

export function isFresh(p: Price, currentSlot: number | null, network: Network): boolean {
  if (currentSlot === null) return false;
  // devnet slots are unrelated to mainnet slots: freshness of a reference price is judged by cache age only
  if (p.reference || network === 'devnet') return true;
  return currentSlot - p.slot <= MAX_PRICE_AGE_SLOTS;
}
