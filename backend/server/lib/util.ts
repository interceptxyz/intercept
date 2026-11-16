import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export const bad = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const forbidden = (message = 'You do not have permission to do this.', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found.`);
export const unauthorized = (message = 'Missing or invalid credentials.', code = 'UNAUTHENTICATED') => new HttpError(401, code, message);

export const newId = (prefix: string) => `${prefix}_${randomBytes(10).toString('base64url').replace(/[-_]/g, '').slice(0, 14).padEnd(14, '0')}`;
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hmac = (key: string, s: string) => createHmac('sha256', key).update(s).digest('hex');
export function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isBase58Address = (s: unknown): s is string => typeof s === 'string' && BASE58.test(s);

/**
 * Decimal arithmetic on strings, exact, fixed scale. Used for USD values: no floating point is
 * ever used for money. Internally a bigint scaled by 10^SCALE.
 */
export const SCALE = 9;
const F = 10n ** BigInt(SCALE);
export type Dec = bigint;
export function dec(v: string | number | bigint): Dec {
  if (typeof v === 'bigint') return v * F;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('dec(number) only accepts safe integers');
    return BigInt(v) * F;
  }
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) throw new Error(`invalid decimal: ${v}`);
  const frac = (m[3] ?? '').slice(0, SCALE).padEnd(SCALE, '0');
  const r = BigInt(m[2]) * F + BigInt(frac);
  return m[1] ? -r : r;
}
export function decStr(d: Dec, places = SCALE): string {
  const neg = d < 0n, a = neg ? -d : d;
  const int = a / F, frac = (a % F).toString().padStart(SCALE, '0').slice(0, places).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}
/** base units → token units as Dec, exact */
export function fromBaseUnits(amount: bigint, decimals: number): Dec {
  return decimals <= SCALE ? amount * 10n ** BigInt(SCALE - decimals) : amount / 10n ** BigInt(decimals - SCALE);
}
/** (token units) × (price) → USD, both Dec */
export const mulDec = (a: Dec, b: Dec): Dec => (a * b) / F;
export const isDecString = (s: unknown): s is string => typeof s === 'string' && /^\d{1,18}(\.\d{1,9})?$/.test(s);

export const nowIso = () => new Date().toISOString();
export const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
