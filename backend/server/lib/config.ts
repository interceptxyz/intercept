import { createPrivateKey, createPublicKey, KeyObject } from 'crypto';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PRIVY_APP_ID: z.string().default(''),
  PRIVY_APP_SECRET: z.string().default(''),
  /** HMAC key for API key digests: a database leak alone cannot be used to test key guesses offline */
  API_KEY_PEPPER: z.string().min(32),
  /** Ed25519 private key (PKCS#8 DER, base64) that signs execution authorizations */
  AUTHORIZATION_SIGNING_KEY: z.string().min(40),
  APP_ORIGINS: z.string().default('https://app.intercepting.xyz,https://www.intercepting.xyz'),
  PUBLIC_API_URL: z.string().default('https://api.intercepting.xyz'),
  COOKIE_SECURE: z.enum(['1', '0']).default('1'),
});

export interface Config {
  databaseUrl: string; privyAppId: string; privySecret: string; pepper: string;
  signingKey: KeyObject; publicKey: KeyObject; keyId: string; publicKeyB64: string;
  origins: Set<string>; publicApiUrl: string; cookieSecure: boolean;
}

let cached: Config | null = null;
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const e = schema.parse(env);
  const signingKey = createPrivateKey({ key: Buffer.from(e.AUTHORIZATION_SIGNING_KEY, 'base64'), format: 'der', type: 'pkcs8' });
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('AUTHORIZATION_SIGNING_KEY must be an Ed25519 key');
  const publicKey = createPublicKey(signingKey);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  cached = {
    databaseUrl: e.DATABASE_URL, privyAppId: e.PRIVY_APP_ID, privySecret: e.PRIVY_APP_SECRET, pepper: e.API_KEY_PEPPER,
    signingKey, publicKey, publicKeyB64: Buffer.from(raw).toString('base64'),
    keyId: 'ak_' + require('crypto').createHash('sha256').update(raw).digest('hex').slice(0, 12),
    origins: new Set(e.APP_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)),
    publicApiUrl: e.PUBLIC_API_URL, cookieSecure: e.COOKIE_SECURE === '1',
  };
  return cached;
}
export function resetConfig() { cached = null; }
