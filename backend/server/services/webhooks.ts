/**
 * Webhooks: signed with HMAC-SHA256 (header `Intercept-Signature: t=<unix>,v1=<hex>` over
 * "<t>.<body>"). Delivery is attempted right after the event and retried with exponential backoff
 * (opportunistically on later requests; also via POST .../redeliver). URLs must be public HTTPS.
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Db, one, q } from '../db';
import { bad, hmac, newId, secret } from '../lib/util';

export const WEBHOOK_EVENTS = ['evaluation.denied', 'evaluation.approval_required', 'evaluation.resolved', 'alert.created', 'agent.status_changed', 'api_key.revoked', 'organization.emergency_stop'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
const MAX_ATTEMPTS = 6;

function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
}

export async function assertPublicUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw bad('INVALID_WEBHOOK_URL', 'Not a valid URL.'); }
  if (u.protocol !== 'https:') throw bad('INVALID_WEBHOOK_URL', 'Webhook URLs must use HTTPS.');
  if (u.username || u.password) throw bad('INVALID_WEBHOOK_URL', 'Credentials in the URL are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw bad('INVALID_WEBHOOK_URL', 'The host does not resolve.');
  if (addrs.some(privateIp)) throw bad('INVALID_WEBHOOK_URL', 'Webhook URLs must point to a public address.');
  return u;
}

export async function createWebhook(db: Db, orgId: string, userId: string, url: string, events: WebhookEvent[]) {
  await assertPublicUrl(url);
  const id = newId('whk'), s = 'whsec_' + secret(24);
  await q(db, 'INSERT INTO webhooks(id, org_id, url, events, secret, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, orgId, url, events, s, userId]);
  return { id, secret: s };
}

/** Records one delivery per subscribed webhook. Returns ids to attempt. */
export async function emit(db: Db, orgId: string, event: WebhookEvent, data: Record<string, unknown>): Promise<string[]> {
  const hooks = await q(db, 'SELECT id FROM webhooks WHERE org_id = $1 AND disabled_at IS NULL AND $2 = ANY(events)', [orgId, event]);
  const ids: string[] = [];
  for (const h of hooks) {
    const id = newId('dlv');
    const payload = { id, type: event, createdAt: new Date().toISOString(), organizationId: orgId, data };
    await q(db, `INSERT INTO webhook_deliveries(id, org_id, webhook_id, event, payload, status, next_attempt_at) VALUES ($1,$2,$3,$4,$5,'PENDING', now())`, [id, orgId, h.id, event, JSON.stringify(payload)]);
    ids.push(id);
  }
  return ids;
}

export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;
let poster: Poster = async (url, body, headers) => {
  await assertPublicUrl(url); // re-checked at delivery time (DNS rebinding)
  const r = await fetch(url, { method: 'POST', body, headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  return { status: r.status };
};
export function setPoster(p: Poster) { poster = p; }

export function signature(secretKey: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmac(secretKey, `${t}.${body}`)}`;
}

export async function attempt(db: Db, deliveryId: string) {
  const d = await one(db, `SELECT d.*, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = $1 AND d.status = 'PENDING' AND w.disabled_at IS NULL`, [deliveryId]);
  if (!d) return null;
  const body = JSON.stringify(d.payload);
  let status = 0, error: string | null = null;
  try { status = (await poster(d.url, body, { 'content-type': 'application/json', 'user-agent': 'Intercept-Webhooks/1', 'intercept-signature': signature(d.secret, body), 'intercept-event': d.event, 'intercept-delivery': d.id })).status; }
  catch (e: any) { error = String(e.message ?? e).slice(0, 300); }
  const attempts = d.attempts + 1;
  const ok = status >= 200 && status < 300;
  const final = ok ? 'DELIVERED' : attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
  const backoff = Math.min(3600, 30 * 2 ** (attempts - 1));
  await q(db, `UPDATE webhook_deliveries SET attempts = $2, status = $3, last_status_code = $4, last_error = $5, next_attempt_at = CASE WHEN $3 = 'PENDING' THEN now() + ($6 || ' seconds')::interval ELSE NULL END WHERE id = $1`,
    [d.id, attempts, final, status || null, error ?? (ok ? null : `HTTP ${status}`), String(backoff)]);
  return final;
}

/** Retries due deliveries (any tenant). Called opportunistically after requests. */
export async function drainDue(db: Db, limit = 5) {
  const due = await q(db, `SELECT id FROM webhook_deliveries WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1`, [limit]);
  for (const d of due) await attempt(db, d.id).catch(() => undefined);
}

// -------------------------------------------------------------------------------- alerts

export async function alert(db: Db, a: { orgId: string; agentId?: string | null; evaluationId?: string | null; type: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; message: string }) {
  const id = newId('alr');
  await q(db, 'INSERT INTO alerts(id, org_id, agent_id, evaluation_id, type, severity, message) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, a.orgId, a.agentId ?? null, a.evaluationId ?? null, a.type, a.severity, a.message]);
  const deliveries = await emit(db, a.orgId, 'alert.created', { alertId: id, type: a.type, severity: a.severity, message: a.message, agentId: a.agentId ?? null, evaluationId: a.evaluationId ?? null });
  return { id, deliveries };
}
