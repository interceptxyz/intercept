/**
 * External intelligence providers. Their results are evidence (source type EXTERNAL), never truth,
 * and are kept internal: raw provider data is not redistributed (licensing not reviewed).
 *
 * Operational: GoPlus address security, for Robinhood Chain (chain id 4663 listed by
 * GET /api/v1/supported_chains and answering address_security, checked 2026-11-17). Its address
 * endpoint does not answer for the other evaluated networks, so it is not offered there.
 * Evaluated but not integrated: Forta, Chainabuse, Scam Sniffer (no verified Robinhood Chain support).
 */
import { Db, one, q } from '../db';
import { CHAINS, Category, Chain } from './model';

export interface ExternalThreatResult { provider: string; flagged: boolean; categories: Category[]; signals: string[]; source: string | null }
export interface ThreatIntelligenceProvider {
  name: string;
  supports(chain: Chain): boolean;
  lookupAddress(input: { chain: Chain; address: string }): Promise<ExternalThreatResult>;
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
let fetcher: Fetch = (url) => fetch(url, { signal: AbortSignal.timeout(Number(process.env.PROVIDER_TIMEOUT_MS ?? 5000)) }) as any;
export function setProviderFetch(f: Fetch) { fetcher = f; for (const h of health.values()) Object.assign(h, { failures: 0, openUntil: 0 }); }

const MAP: [string, Category][] = [['stealing_attack', 'WALLET_DRAINER'], ['phishing_activities', 'PHISHING_ADDRESS'], ['honeypot_related_address', 'HONEYPOT'], ['fake_token', 'MALICIOUS_TOKEN'],
  ['number_of_malicious_contracts_created', 'MALICIOUS_CONTRACT'], ['cybercrime', 'MALICIOUS_CONTRACT'], ['financial_crime', 'MALICIOUS_CONTRACT'], ['blackmail_activities', 'MALICIOUS_CONTRACT'],
  ['sanctioned', 'MALICIOUS_CONTRACT'], ['money_laundering', 'MALICIOUS_CONTRACT'], ['fake_standard_interface', 'MALICIOUS_TOKEN'], ['blacklist_doubt', 'SUSPICIOUS_PATTERN']];

export const goplus: ThreatIntelligenceProvider = {
  name: 'goplus',
  supports: (chain) => CHAINS[chain].family === 'evm',
  async lookupAddress({ chain, address }) {
    const id = (CHAINS[chain] as any).chainId;
    const r = await fetcher(`https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=${id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== 1 || !j.result) throw new Error(`provider error ${j.code}: ${j.message}`);
    const signals = MAP.filter(([k]) => j.result[k] && j.result[k] !== '0').map(([k]) => k);
    const cats = [...new Set(MAP.filter(([k]) => signals.includes(k)).map(([, c]) => c))];
    return { provider: 'goplus', flagged: signals.length > 0, categories: cats, signals, source: j.result.data_source || null };
  },
};
export const PROVIDERS: ThreatIntelligenceProvider[] = process.env.GOPLUS_ENABLED === '0' ? [] : [goplus];

// ------------------------------------------------------------------ circuit breaker + health
interface Health { failures: number; openUntil: number; lastSuccessAt: string | null; lastError: string | null; calls: number }
const health = new Map<string, Health>();
const h = (n: string) => { let x = health.get(n); if (!x) health.set(n, (x = { failures: 0, openUntil: 0, lastSuccessAt: null, lastError: null, calls: 0 })); return x; };
export const providerHealth = () => PROVIDERS.map((p) => { const x = h(p.name); return { name: p.name, chains: Object.keys(CHAINS).filter((c) => p.supports(c as Chain)), circuit: x.openUntil > Date.now() ? 'OPEN' : 'CLOSED', lastSuccessAt: x.lastSuccessAt, lastError: x.lastError, calls: x.calls }; });

const CACHE_HOURS = 24;
/** Cached (24 h, in Postgres), retried once, behind a breaker (3 failures → 60 s open). Null when unavailable. */
export async function lookupExternal(db: Db, p: ThreatIntelligenceProvider, chain: Chain, address: string): Promise<ExternalThreatResult | null> {
  if (!p.supports(chain)) return null;
  const cached = await one(db, `SELECT result FROM network_provider_cache WHERE provider = $1 AND chain = $2 AND value = $3 AND fetched_at > now() - ($4 || ' hours')::interval`, [p.name, chain, address, String(CACHE_HOURS)]);
  if (cached) return cached.result;
  const st = h(p.name);
  if (st.openUntil > Date.now()) return null;
  for (let i = 0; i < 2; i++) {
    st.calls++;
    try {
      const r = await p.lookupAddress({ chain, address });
      st.failures = 0; st.lastSuccessAt = new Date().toISOString();
      await q(db, `INSERT INTO network_provider_cache(provider, chain, value, result) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, chain, value) DO UPDATE SET result = EXCLUDED.result, fetched_at = now()`, [p.name, chain, address, JSON.stringify(r)]);
      return r;
    } catch (e: any) {
      st.lastError = String(e.message ?? e).slice(0, 200);
      if (++st.failures >= 3) { st.openUntil = Date.now() + 60_000; return null; }
    }
  }
  return null;
}
