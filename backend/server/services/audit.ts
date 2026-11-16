import { Db } from '../db';

export interface AuditEntry {
  orgId: string; actorType: 'user' | 'api_key' | 'system'; actorId: string; action: string;
  targetType?: string; targetId?: string; detail?: Record<string, unknown>; ip?: string | null;
}

/** Append-only. Secrets must never be passed in `detail`. */
export async function audit(db: Db, e: AuditEntry) {
  await db.query('INSERT INTO audit_logs(org_id, actor_type, actor_id, action, target_type, target_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [e.orgId, e.actorType, e.actorId, e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.detail ?? {}), e.ip ?? null]);
}
