/**
 * Intercept Network: vocabulary, chain identifiers and normalization (pure).
 *
 * Chains: the networks the engine evaluates ('mainnet-beta', 'devnet') plus Robinhood Chain
 * ('eip155:4663', chain id verified with eth_chainId on the configured RPC). Indicators are keyed by
 * chain, so testnet observations can never create or match mainnet indicators.
 */
import { isBase58Address } from '../lib/util';

export const CHAINS = {
  'mainnet-beta': { family: 'base58', testnet: false, evaluated: true },
  devnet: { family: 'base58', testnet: true, evaluated: true },
  'eip155:4663': { family: 'evm', testnet: false, evaluated: false, chainId: 4663 },
} as const;
export type Chain = keyof typeof CHAINS;
export const isChain = (c: unknown): c is Chain => typeof c === 'string' && c in CHAINS;

export const INDICATOR_TYPES = ['ADDRESS', 'CONTRACT', 'TX_HASH', 'BYTECODE_HASH', 'PROXY_IMPLEMENTATION', 'SELECTOR_CONTEXT', 'PATTERN_FINGERPRINT'] as const;
export type IndicatorType = (typeof INDICATOR_TYPES)[number];
/** Indicator types that may be matched against transactions. Selector / bytecode / pattern similarity alone is never proof. */
export const MATCHABLE: IndicatorType[] = ['ADDRESS', 'CONTRACT', 'PROXY_IMPLEMENTATION'];

export const CATEGORIES = ['MALICIOUS_CONTRACT', 'PHISHING_ADDRESS', 'WALLET_DRAINER', 'UNAUTHORIZED_TRANSFER', 'DANGEROUS_APPROVAL', 'EXPLOIT_CONTRACT',
  'SUSPICIOUS_PROXY', 'MALICIOUS_UPGRADE', 'ADDRESS_POISONING', 'HONEYPOT', 'RUG_PULL', 'SUSPICIOUS_PATTERN', 'COMPROMISED_AGENT', 'MALICIOUS_TOKEN'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ['INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const sevRank = (s: string) => SEVERITIES.indexOf(s as Severity);

export const STATUSES = ['REPORTED', 'UNDER_REVIEW', 'SUSPECTED', 'VERIFIED', 'DISPUTED', 'REVOKED', 'EXPIRED', 'FALSE_POSITIVE'] as const;
export type Status = (typeof STATUSES)[number];
/** Statuses visible in the shared registry (REPORTED and UNDER_REVIEW stay internal). */
export const PUBLISHED: Status[] = ['SUSPECTED', 'VERIFIED', 'DISPUTED', 'REVOKED', 'EXPIRED', 'FALSE_POSITIVE'];
/** Statuses that can affect a transaction evaluation. */
export const ACTIVE: Status[] = ['SUSPECTED', 'VERIFIED'];

export const SOURCE_TYPES = ['FIREWALL', 'SIMULATION', 'AGENT_MONITORING', 'USER_REPORT', 'EXTERNAL', 'ADMIN', 'ONCHAIN'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SHARING = ['PRIVATE', 'ANONYMIZED_INTELLIGENCE', 'AUTHORIZED_CONTRIBUTION'] as const;
export type Sharing = (typeof SHARING)[number];

export const EVENT_TYPES = ['threat.reported', 'threat.verified', 'threat.updated', 'threat.disputed', 'threat.revoked', 'threat.expired', 'threat.false_positive', 'threat.match.detected'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Baseline impact per category (a reviewer may set another severity when verifying). */
export const CATEGORY_SEVERITY: Record<Category, Severity> = {
  WALLET_DRAINER: 'CRITICAL', EXPLOIT_CONTRACT: 'CRITICAL', MALICIOUS_UPGRADE: 'HIGH', DANGEROUS_APPROVAL: 'HIGH', PHISHING_ADDRESS: 'HIGH',
  MALICIOUS_CONTRACT: 'HIGH', UNAUTHORIZED_TRANSFER: 'HIGH', COMPROMISED_AGENT: 'HIGH', SUSPICIOUS_PROXY: 'MEDIUM', ADDRESS_POISONING: 'MEDIUM',
  HONEYPOT: 'MEDIUM', RUG_PULL: 'MEDIUM', MALICIOUS_TOKEN: 'MEDIUM', SUSPICIOUS_PATTERN: 'LOW',
};

export class NormalizeError extends Error { constructor(m: string) { super(m); } }

/** EVM addresses are stored lowercase; base58 values are case-sensitive and kept as is. */
export function normalizeValue(chain: Chain, type: IndicatorType, raw: string): string {
  const v = String(raw ?? '').trim();
  const fam = CHAINS[chain].family;
  if (type === 'ADDRESS' || type === 'CONTRACT' || type === 'PROXY_IMPLEMENTATION') {
    if (fam === 'evm') { if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new NormalizeError('expected a 0x-prefixed 20-byte address'); return v.toLowerCase(); }
    if (!isBase58Address(v)) throw new NormalizeError('expected a base58 address');
    return v;
  }
  if (type === 'TX_HASH') {
    if (fam === 'evm') { if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new NormalizeError('expected a 0x-prefixed 32-byte transaction hash'); return v.toLowerCase(); }
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v)) throw new NormalizeError('expected a base58 transaction signature');
    return v;
  }
  if (type === 'BYTECODE_HASH') { if (!/^(0x)?[0-9a-fA-F]{64}$/.test(v)) throw new NormalizeError('expected a 32-byte hex hash'); return v.toLowerCase().replace(/^0x/, ''); }
  if (type === 'SELECTOR_CONTEXT') { if (!/^0x[0-9a-fA-F]{8}@.{1,120}$/.test(v)) throw new NormalizeError('expected 0x<4-byte selector>@<context>'); return v.slice(0, 10).toLowerCase() + v.slice(10); }
  if (!/^[A-Za-z0-9:_\-.]{8,128}$/.test(v)) throw new NormalizeError('expected a pattern fingerprint (8-128 chars of [A-Za-z0-9:_-.])');
  return v;
}

/** Transaction hashes on the chain family, for evidence references. */
export function normalizeTxHash(chain: Chain, raw: string) { return normalizeValue(chain, 'TX_HASH', raw); }
