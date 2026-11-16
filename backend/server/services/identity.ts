/**
 * Identity: Privy handles account creation and login (email OTP, wallets). We verify the Privy
 * access token (ES256 JWT) ourselves, then open a server-side session stored in Postgres, so a
 * session can be revoked at any time.
 */
import { createPublicKey, KeyObject, verify as cverify } from 'crypto';
import { PoolClient } from 'pg';
import { Db, one, q, tx } from '../db';
import { config } from '../lib/config';
import { newId, secret, sha256, unauthorized } from '../lib/util';
import { audit } from './audit';

export interface Identity { did: string; email: string | null; wallet: string | null }
export type IdentityVerifier = (token: string) => Promise<Identity | null>;

let keyCache: { key: KeyObject; at: number } | null = null;
async function privy(path: string) {
  const c = config();
  const r = await fetch('https://auth.privy.io/api/v1' + path, {
    headers: { authorization: 'Basic ' + Buffer.from(`${c.privyAppId}:${c.privySecret}`).toString('base64'), 'privy-app-id': c.privyAppId },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`privy ${path.split('/')[1]} ${r.status}`);
  return r.json() as Promise<any>;
}
async function verificationKey() {
  if (keyCache && keyCache.at > Date.now() - 3_600_000) return keyCache.key;
  const app = await privy('/apps/' + config().privyAppId);
  // Privy returns the PEM on one line, which OpenSSL rejects: rewrap it
  const b64 = String(app.verification_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
  keyCache = { key: createPublicKey(pem), at: Date.now() };
  return keyCache.key;
}

export const privyVerifier: IdentityVerifier = async (token) => {
  const c = config();
  if (!c.privyAppId || !c.privySecret) throw new Error('Privy is not configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header: any;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return null; }
  if (header.alg !== 'ES256') return null;
  const key = await verificationKey();
  let ok = false;
  try { ok = cverify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')); } catch { ok = false; }
  if (!ok) return null;
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (claims.iss !== 'privy.io' || claims.aud !== c.privyAppId || !claims.sub || !(claims.exp > Date.now() / 1000)) return null;
  let email: string | null = null, wallet: string | null = null;
  try {
    const u = await privy('/users/' + encodeURIComponent(claims.sub));
    for (const a of u.linked_accounts ?? []) {
      if (a.type === 'email' && !email) email = a.address;
      if (a.type === 'wallet' && a.chain_type === 'solana' && !wallet) wallet = a.address;
    }
  } catch { /* profile is optional */ }
  return { did: claims.sub, email, wallet };
};

export const SESSION_COOKIE = 'icpt_session';
export const SESSION_TTL_SECS = 7 * 86_400;

/** Upserts the user; the first login creates a personal organization owned by them. */
export async function login(identity: Identity, userAgent: string | null, ip: string | null) {
  return tx(async (c: PoolClient) => {
    const display = identity.email ?? (identity.wallet ? `${identity.wallet.slice(0, 4)}…${identity.wallet.slice(-4)}` : 'Account');
    let user = await one(c, 'SELECT * FROM users WHERE privy_did = $1', [identity.did]);
    if (!user) {
      user = await one(c, 'INSERT INTO users(id, privy_did, email, wallet, display, last_login_at) VALUES ($1,$2,$3,$4,$5, now()) RETURNING *', [newId('usr'), identity.did, identity.email, identity.wallet, display]);
      const orgId = newId('org');
      await c.query('INSERT INTO organizations(id, name, created_by) VALUES ($1,$2,$3)', [orgId, `${display.split('@')[0]}'s organization`, user.id]);
      await c.query(`INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,'OWNER')`, [orgId, user.id]);
      await audit(c, { orgId, actorType: 'user', actorId: user.id, action: 'organization.create', targetType: 'organization', targetId: orgId, ip });
    } else {
      await c.query('UPDATE users SET email = COALESCE($2, email), wallet = COALESCE($3, wallet), last_login_at = now() WHERE id = $1', [user.id, identity.email, identity.wallet]);
    }
    const token = 'ses_' + secret(32);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECS * 1000);
    await c.query('INSERT INTO sessions(id, user_id, expires_at, user_agent) VALUES ($1,$2,$3,$4)', [sha256(token), user.id, expiresAt, userAgent?.slice(0, 200) ?? null]);
    return { token, expiresAt, user };
  });
}

export async function sessionUser(db: Db, token: string | null) {
  if (!token || !token.startsWith('ses_')) return null;
  return one(db, `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)]);
}

export async function logout(db: Db, token: string) {
  await q(db, 'UPDATE sessions SET revoked_at = now() WHERE id = $1', [sha256(token)]);
}

export async function requireSessionUser(db: Db, token: string | null) {
  const u = await sessionUser(db, token);
  if (!u) throw unauthorized('Sign in first.');
  return u;
}
