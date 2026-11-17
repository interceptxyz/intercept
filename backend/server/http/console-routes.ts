/** Routes for people (dashboard): wallet/email session via Privy, organization roles. */
import { FastifyInstance } from 'fastify';
import { createPublicKey, verify as edVerify } from 'crypto';
import bs58 from 'bs58';
import { z } from 'zod';
import { getPool, one, q, tx } from '../db';
import { HttpError, bad, forbidden, isBase58Address, newId, notFound, secret, sha256 } from '../lib/util';
import { canonical, DEFAULT_POLICY, parsePolicy } from '../policy/schema';
import { IdentityVerifier, SESSION_COOKIE, SESSION_TTL_SECS, login, logout } from '../services/identity';
import { KEY_SCOPES, createKey, keyView } from '../services/keys';
import { WEBHOOK_EVENTS, attempt, createWebhook, emit } from '../services/webhooks';
import { audit } from '../services/audit';
import { evaluate, evaluationView, getEvaluation, resolveApproval } from '../services/evaluations';
import { body, cookie, ip, member, setSessionCookie, user } from './context';

const name = z.string().trim().min(1).max(64);
const agentView = (a: any) => ({
  id: a.id, name: a.name, description: a.description, wallet: a.wallet, walletVerified: !!a.wallet_verified_at, walletVerifiedAt: a.wallet_verified_at,
  network: a.network, status: a.status, integrationMode: a.integration_mode, policy: { id: a.policy_id, version: a.policy_version },
  createdAt: a.created_at, lastActivityAt: a.last_activity_at,
});

async function createPolicy(c: any, orgId: string, userId: string, nm: string, config: unknown) {
  const p = parsePolicy(config);
  if (!p.ok) throw bad('INVALID_POLICY', 'The policy configuration is invalid.', p.issues);
  const id = newId('pol');
  await c.query('INSERT INTO policies(id, org_id, name, current_version) VALUES ($1,$2,$3,1)', [id, orgId, nm]);
  await c.query('INSERT INTO policy_versions(policy_id, version, org_id, config, config_hash, created_by) VALUES ($1,1,$2,$3,$4,$5)', [id, orgId, JSON.stringify(p.config), sha256(canonical(p.config)), userId]);
  return { id, version: 1, config: p.config };
}

export function consoleRoutes(app: FastifyInstance, verifier: IdentityVerifier) {
  const db = getPool();

  // ------------------------------------------------------------------ session
  app.post('/v1/auth/privy', async (req, reply) => {
    const b = body(req, z.object({ token: z.string().min(20).max(4000) }));
    const identity = await verifier(b.token);
    if (!identity) throw new HttpError(401, 'INVALID_IDENTITY', 'Your sign-in could not be verified. Try again.');
    const s = await login(identity, req.headers['user-agent'] ?? null, ip(req));
    setSessionCookie(reply, s.token, SESSION_TTL_SECS);
    return { user: { id: s.user.id, display: s.user.display, email: s.user.email, wallet: s.user.wallet }, expiresAt: s.expiresAt };
  });
  app.get('/v1/auth/session', async (req) => {
    try {
      const u = await user(req);
      const orgs = await q(db, 'SELECT o.id, o.name, m.role, o.emergency_stop FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.created_at', [u.id]);
      return { user: { id: u.id, display: u.display, email: u.email, wallet: u.wallet }, organizations: orgs.map((o) => ({ id: o.id, name: o.name, role: o.role, emergencyStop: o.emergency_stop })) };
    } catch (e) { if (e instanceof HttpError && e.status === 401) return { user: null }; throw e; }
  });
  app.post('/v1/auth/logout', async (req, reply) => {
    const t = cookie(req, SESSION_COOKIE);
    if (t) await logout(db, t);
    setSessionCookie(reply, '', 0);
    return { ok: true };
  });

  // ------------------------------------------------------------------ organizations
  app.post('/v1/orgs', async (req, reply) => {
    const u = await user(req);
    const b = body(req, z.object({ name }));
    const id = newId('org');
    await tx(async (c) => {
      await c.query('INSERT INTO organizations(id, name, created_by) VALUES ($1,$2,$3)', [id, b.name, u.id]);
      await c.query(`INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,'OWNER')`, [id, u.id]);
      await audit(c, { orgId: id, actorType: 'user', actorId: u.id, action: 'organization.create', targetType: 'organization', targetId: id, ip: ip(req) });
    });
    return reply.status(201).send({ id, name: b.name, role: 'OWNER' });
  });
  app.get('/v1/orgs/:orgId', async (req) => {
    const m = await member(req);
    const o = await one(db, 'SELECT * FROM organizations WHERE id = $1', [m.orgId]);
    return { id: o.id, name: o.name, emergencyStop: o.emergency_stop, publicFeed: o.public_feed, createdAt: o.created_at, role: m.role };
  });
  app.patch('/v1/orgs/:orgId', async (req) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ name: name.optional(), publicFeed: z.boolean().optional() }));
    if (b.name !== undefined) await q(db, 'UPDATE organizations SET name = $2 WHERE id = $1', [m.orgId, b.name]);
    if (b.publicFeed !== undefined) await q(db, 'UPDATE organizations SET public_feed = $2 WHERE id = $1', [m.orgId, b.publicFeed]);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'organization.update', detail: b, ip: ip(req) });
    return { ok: true };
  });
  app.post('/v1/orgs/:orgId/emergency-stop', async (req) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ active: z.boolean() }));
    // anyone with ADMIN may stop; only an OWNER may lift the stop
    if (!b.active && m.role !== 'OWNER') throw forbidden('Only an owner can lift the emergency stop.');
    await tx(async (c) => {
      await c.query('UPDATE organizations SET emergency_stop = $2 WHERE id = $1', [m.orgId, b.active]);
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: b.active ? 'emergency_stop.activate' : 'emergency_stop.lift', ip: ip(req) });
      await emit(c, m.orgId, 'organization.emergency_stop', { active: b.active, by: m.user.id });
    });
    return { emergencyStop: b.active };
  });

  // members & invitations
  app.get('/v1/orgs/:orgId/members', async (req) => {
    const m = await member(req);
    return q(db, 'SELECT u.id, u.display, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at', [m.orgId]);
  });
  app.patch('/v1/orgs/:orgId/members/:userId', async (req) => {
    const m = await member(req, 'OWNER');
    const b = body(req, z.object({ role: z.enum(['OWNER', 'ADMIN', 'VIEWER']) }));
    const target = (req.params as any).userId;
    await tx(async (c) => {
      const owners = (await c.query(`SELECT user_id FROM memberships WHERE org_id = $1 AND role = 'OWNER' FOR UPDATE`, [m.orgId])).rows;
      if (b.role !== 'OWNER' && owners.length === 1 && owners[0].user_id === target) throw bad('LAST_OWNER', 'An organization needs at least one owner.');
      const r = await c.query('UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2', [m.orgId, target, b.role]);
      if (r.rowCount !== 1) throw notFound('Member');
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'member.role', targetType: 'user', targetId: target, detail: { role: b.role }, ip: ip(req) });
    });
    return { ok: true };
  });
  app.delete('/v1/orgs/:orgId/members/:userId', async (req) => {
    const target = (req.params as any).userId;
    const u = await user(req);
    const m = await member(req, target === u.id ? 'VIEWER' : 'OWNER'); // anyone may leave
    await tx(async (c) => {
      const owners = (await c.query(`SELECT user_id FROM memberships WHERE org_id = $1 AND role = 'OWNER' FOR UPDATE`, [m.orgId])).rows;
      if (owners.length === 1 && owners[0].user_id === target) throw bad('LAST_OWNER', 'An organization needs at least one owner.');
      const r = await c.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [m.orgId, target]);
      if (r.rowCount !== 1) throw notFound('Member');
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'member.remove', targetType: 'user', targetId: target, ip: ip(req) });
    });
    return { ok: true };
  });
  app.post('/v1/orgs/:orgId/invitations', async (req, reply) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ role: z.enum(['ADMIN', 'VIEWER']), email: z.string().email().max(200).optional() }));
    if (b.role === 'ADMIN' && m.role !== 'OWNER') throw forbidden('Only an owner can invite administrators.');
    const token = 'inv_' + secret(24), id = newId('inv');
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    await q(db, 'INSERT INTO invitations(id, org_id, token_hash, role, email, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, m.orgId, sha256(token), b.role, b.email ?? null, m.user.id, expiresAt]);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'invitation.create', targetType: 'invitation', targetId: id, detail: { role: b.role, email: b.email ?? null }, ip: ip(req) });
    return reply.status(201).send({ id, role: b.role, expiresAt, token, url: `https://app.intercepting.xyz/#/invite/${token}` });
  });
  app.get('/v1/orgs/:orgId/invitations', async (req) => {
    const m = await member(req, 'ADMIN');
    return q(db, 'SELECT id, role, email, expires_at, accepted_at, revoked_at, created_at FROM invitations WHERE org_id = $1 ORDER BY created_at DESC', [m.orgId]);
  });
  app.delete('/v1/orgs/:orgId/invitations/:id', async (req) => {
    const m = await member(req, 'ADMIN');
    await q(db, 'UPDATE invitations SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL', [(req.params as any).id, m.orgId]);
    return { ok: true };
  });
  app.post('/v1/invitations/accept', async (req) => {
    const u = await user(req);
    const b = body(req, z.object({ token: z.string().startsWith('inv_').max(100) }));
    return tx(async (c) => {
      const inv = await one(c, 'SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE', [sha256(b.token)]);
      if (!inv || inv.revoked_at || inv.accepted_at || new Date(inv.expires_at) <= new Date()) throw bad('INVALID_INVITATION', 'This invitation is invalid or expired.');
      if (inv.email && u.email && inv.email.toLowerCase() !== u.email.toLowerCase()) throw forbidden('This invitation was sent to another email address.');
      await c.query('INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [inv.org_id, u.id, inv.role]);
      await c.query('UPDATE invitations SET accepted_by = $2, accepted_at = now() WHERE id = $1', [inv.id, u.id]);
      await audit(c, { orgId: inv.org_id, actorType: 'user', actorId: u.id, action: 'invitation.accept', targetType: 'invitation', targetId: inv.id, ip: ip(req) });
      return { orgId: inv.org_id, role: inv.role };
    });
  });

  // ------------------------------------------------------------------ policies
  app.get('/v1/policy-schema/default', async () => DEFAULT_POLICY);
  app.post('/v1/policies/validate', async (req) => {
    await user(req);
    const r = parsePolicy((req.body as any)?.config);
    return r.ok ? { valid: true, config: r.config } : { valid: false, issues: r.issues };
  });
  app.get('/v1/orgs/:orgId/policies', async (req) => {
    const m = await member(req);
    const rows = await q(db, `SELECT p.*, v.config, v.created_at AS version_created_at, (SELECT count(*)::int FROM agents a WHERE a.policy_id = p.id AND a.status <> 'REVOKED') AS agents
      FROM policies p JOIN policy_versions v ON v.policy_id = p.id AND v.version = p.current_version WHERE p.org_id = $1 AND p.archived_at IS NULL ORDER BY p.created_at`, [m.orgId]);
    return rows.map((p) => ({ id: p.id, name: p.name, currentVersion: p.current_version, config: p.config, agents: p.agents, createdAt: p.created_at, updatedAt: p.version_created_at }));
  });
  app.post('/v1/orgs/:orgId/policies', async (req, reply) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ name, config: z.unknown().optional() }));
    const p = await tx(async (c) => {
      const out = await createPolicy(c, m.orgId, m.user.id, b.name, b.config ?? DEFAULT_POLICY);
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'policy.create', targetType: 'policy', targetId: out.id, ip: ip(req) });
      return out;
    });
    return reply.status(201).send(p);
  });
  app.get('/v1/orgs/:orgId/policies/:id', async (req) => {
    const m = await member(req);
    const p = await one(db, 'SELECT * FROM policies WHERE id = $1 AND org_id = $2', [(req.params as any).id, m.orgId]);
    if (!p) throw notFound('Policy');
    const versions = await q(db, 'SELECT version, config, config_hash, created_by, created_at FROM policy_versions WHERE policy_id = $1 AND org_id = $2 ORDER BY version DESC', [p.id, m.orgId]);
    return { id: p.id, name: p.name, currentVersion: p.current_version, archivedAt: p.archived_at, versions };
  });
  /** Creates a new immutable version. Agents stay pinned to their version unless `applyToAgents`. */
  app.post('/v1/orgs/:orgId/policies/:id/versions', async (req, reply) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ config: z.unknown(), name: name.optional(), applyToAgents: z.boolean().default(true) }));
    const parsed = parsePolicy(b.config);
    if (!parsed.ok) throw bad('INVALID_POLICY', 'The policy configuration is invalid.', parsed.issues);
    const id = (req.params as any).id;
    const out = await tx(async (c) => {
      const p = await one(c, 'SELECT * FROM policies WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, m.orgId]);
      if (!p || p.archived_at) throw notFound('Policy');
      const version = p.current_version + 1;
      await c.query('INSERT INTO policy_versions(policy_id, version, org_id, config, config_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, version, m.orgId, JSON.stringify(parsed.config), sha256(canonical(parsed.config)), m.user.id]);
      await c.query('UPDATE policies SET current_version = $2, name = COALESCE($3, name) WHERE id = $1', [id, version, b.name ?? null]);
      const moved = b.applyToAgents ? (await c.query(`UPDATE agents SET policy_version = $2 WHERE policy_id = $1 AND org_id = $3 AND status <> 'REVOKED'`, [id, version, m.orgId])).rowCount : 0;
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'policy.version', targetType: 'policy', targetId: id, detail: { version, agentsUpdated: moved }, ip: ip(req) });
      return { id, version, config: parsed.config, agentsUpdated: moved };
    });
    return reply.status(201).send(out);
  });
  app.delete('/v1/orgs/:orgId/policies/:id', async (req) => {
    const m = await member(req, 'ADMIN');
    const id = (req.params as any).id;
    const used = await one(db, `SELECT count(*)::int n FROM agents WHERE policy_id = $1 AND org_id = $2 AND status <> 'REVOKED'`, [id, m.orgId]);
    if (used!.n) throw bad('POLICY_IN_USE', 'Agents use this policy. Assign them another policy first.');
    await q(db, 'UPDATE policies SET archived_at = now() WHERE id = $1 AND org_id = $2', [id, m.orgId]);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'policy.archive', targetType: 'policy', targetId: id, ip: ip(req) });
    return { ok: true };
  });

  // ------------------------------------------------------------------ agents
  app.get('/v1/orgs/:orgId/agents', async (req) => {
    const m = await member(req);
    return (await q(db, 'SELECT * FROM agents WHERE org_id = $1 ORDER BY created_at', [m.orgId])).map(agentView);
  });
  app.post('/v1/orgs/:orgId/agents', async (req, reply) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({
      name, description: z.string().max(500).default(''), wallet: z.string().refine(isBase58Address, 'wallet address (base58)').nullable().default(null),
      network: z.enum(['devnet', 'mainnet-beta']).default('devnet'), policyId: z.string().optional(),
    }));
    const a = await tx(async (c) => {
      const count = await one(c, `SELECT count(*)::int n FROM agents WHERE org_id = $1 AND status <> 'REVOKED'`, [m.orgId]);
      if (count!.n >= 100) throw bad('AGENT_LIMIT', 'At most 100 agents per organization.');
      let policy = b.policyId ? await one(c, 'SELECT id, current_version FROM policies WHERE id = $1 AND org_id = $2 AND archived_at IS NULL', [b.policyId, m.orgId]) : null;
      if (b.policyId && !policy) throw notFound('Policy');
      if (!policy) { const p = await createPolicy(c, m.orgId, m.user.id, `${b.name} policy`, DEFAULT_POLICY); policy = { id: p.id, current_version: 1 }; }
      const id = newId('agt');
      const row = await one(c, `INSERT INTO agents(id, org_id, name, description, wallet, network, status, integration_mode, policy_id, policy_version)
        VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE','EVALUATION',$7,$8) RETURNING *`, [id, m.orgId, b.name, b.description, b.wallet, b.network, policy.id, policy.current_version]);
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'agent.create', targetType: 'agent', targetId: id, detail: { network: b.network }, ip: ip(req) });
      return row;
    });
    return reply.status(201).send(agentView(a));
  });
  app.get('/v1/orgs/:orgId/agents/:id', async (req) => {
    const m = await member(req);
    const a = await one(db, 'SELECT * FROM agents WHERE id = $1 AND org_id = $2', [(req.params as any).id, m.orgId]);
    if (!a) throw notFound('Agent');
    return agentView(a);
  });
  app.patch('/v1/orgs/:orgId/agents/:id', async (req) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({
      name: name.optional(), description: z.string().max(500).optional(),
      wallet: z.string().refine(isBase58Address, 'wallet address (base58)').nullable().optional(),
      integrationMode: z.enum(['EVALUATION', 'ENFORCED_EXECUTION']).optional(),
      policyId: z.string().optional(), policyVersion: z.number().int().positive().optional(),
    }));
    const id = (req.params as any).id;
    const row = await tx(async (c) => {
      const a = await one(c, 'SELECT * FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, m.orgId]);
      if (!a) throw notFound('Agent');
      if (a.status === 'REVOKED') throw bad('AGENT_REVOKED', 'A revoked agent cannot be changed.');
      const walletChanged = b.wallet !== undefined && b.wallet !== a.wallet;
      const mode = b.integrationMode ?? a.integration_mode;
      if (mode === 'ENFORCED_EXECUTION' && (walletChanged || !a.wallet_verified_at)) throw bad('WALLET_NOT_VERIFIED', 'Verify the agent wallet before enabling enforced execution.');
      let policyId = a.policy_id, version = a.policy_version;
      if (b.policyId || b.policyVersion) {
        policyId = b.policyId ?? a.policy_id;
        const p = await one(c, 'SELECT current_version FROM policies WHERE id = $1 AND org_id = $2 AND archived_at IS NULL', [policyId, m.orgId]);
        if (!p) throw notFound('Policy');
        version = b.policyVersion ?? p.current_version;
        const v = await one(c, 'SELECT 1 FROM policy_versions WHERE policy_id = $1 AND version = $2', [policyId, version]);
        if (!v) throw notFound('Policy version');
      }
      const out = await one(c, `UPDATE agents SET name = $3, description = $4, wallet = $5, wallet_verified_at = CASE WHEN $6 THEN NULL ELSE wallet_verified_at END,
        integration_mode = $7, policy_id = $8, policy_version = $9 WHERE id = $1 AND org_id = $2 RETURNING *`,
        [id, m.orgId, b.name ?? a.name, b.description ?? a.description, b.wallet !== undefined ? b.wallet : a.wallet, walletChanged, mode, policyId, version]);
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'agent.update', targetType: 'agent', targetId: id, detail: { ...b }, ip: ip(req) });
      return out;
    });
    return agentView(row);
  });
  for (const action of ['pause', 'resume', 'revoke'] as const) {
    app.post(`/v1/orgs/:orgId/agents/:id/${action}`, async (req) => {
      const m = await member(req, 'ADMIN');
      const id = (req.params as any).id;
      const row = await tx(async (c) => {
        const a = await one(c, 'SELECT * FROM agents WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, m.orgId]);
        if (!a) throw notFound('Agent');
        if (a.status === 'REVOKED') throw bad('AGENT_REVOKED', 'This agent is revoked permanently.');
        const status = action === 'pause' ? 'PAUSED' : action === 'resume' ? 'ACTIVE' : 'REVOKED';
        const out = await one(c, 'UPDATE agents SET status = $3 WHERE id = $1 AND org_id = $2 RETURNING *', [id, m.orgId, status]);
        if (action === 'revoke') await c.query('UPDATE api_keys SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL', [id]);
        await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: `agent.${action}`, targetType: 'agent', targetId: id, ip: ip(req) });
        await emit(c, m.orgId, 'agent.status_changed', { agentId: id, status });
        return out;
      });
      return agentView(row);
    });
  }
  // wallet ownership: the wallet signs a one-time message
  app.post('/v1/orgs/:orgId/agents/:id/wallet-challenge', async (req) => {
    const m = await member(req, 'ADMIN');
    const a = await one(db, 'SELECT * FROM agents WHERE id = $1 AND org_id = $2', [(req.params as any).id, m.orgId]);
    if (!a) throw notFound('Agent');
    if (!a.wallet) throw bad('NO_WALLET', 'Set the agent wallet first.');
    const id = newId('wch');
    const message = `Intercept wallet verification\n\nI control ${a.wallet} and authorize Intercept to enforce policies for agent ${a.id} (${a.name}).\nThis signature cannot move funds.\n\nNonce: ${secret(12)}\nIssued: ${new Date().toISOString()}`;
    await q(db, 'INSERT INTO wallet_challenges(id, org_id, agent_id, wallet, message, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval \'10 minutes\')', [id, m.orgId, a.id, a.wallet, message]);
    return { challengeId: id, message };
  });
  app.post('/v1/orgs/:orgId/agents/:id/wallet-verify', async (req) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ challengeId: z.string(), signature: z.string().min(40).max(200) }));
    return tx(async (c) => {
      const ch = await one(c, `UPDATE wallet_challenges SET used_at = now() WHERE id = $1 AND org_id = $2 AND agent_id = $3 AND used_at IS NULL AND expires_at > now() RETURNING *`, [b.challengeId, m.orgId, (req.params as any).id]);
      if (!ch) throw bad('INVALID_CHALLENGE', 'The challenge is invalid, used or expired.');
      let sig: Buffer;
      try { sig = Buffer.from(bs58.decode(b.signature)); } catch { sig = Buffer.from(b.signature, 'base64'); }
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bs58.decode(ch.wallet))]);
      const ok = sig.length === 64 && edVerify(null, Buffer.from(ch.message), createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig);
      if (!ok) throw bad('INVALID_SIGNATURE', 'The signature does not match the agent wallet.');
      const a = await one(c, 'UPDATE agents SET wallet_verified_at = now() WHERE id = $1 AND org_id = $2 AND wallet = $3 RETURNING *', [ch.agent_id, m.orgId, ch.wallet]);
      if (!a) throw bad('WALLET_CHANGED', 'The agent wallet changed since the challenge was issued.');
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'agent.wallet_verified', targetType: 'agent', targetId: a.id, detail: { wallet: ch.wallet }, ip: ip(req) });
      return agentView(a);
    });
  });

  // ------------------------------------------------------------------ API keys
  app.get('/v1/orgs/:orgId/keys', async (req) => {
    const m = await member(req);
    return (await q(db, 'SELECT * FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC', [m.orgId])).map(keyView);
  });
  const keyBody = z.object({
    agentId: z.string(), name: z.string().trim().min(1).max(64),
    scopes: z.array(z.enum(KEY_SCOPES)).min(1).default(['transactions:evaluate', 'transactions:read', 'agent:read']),
    rateLimitPerMin: z.number().int().min(1).max(600).default(60),
    expiresAt: z.string().datetime().nullable().default(null),
  });
  app.post('/v1/orgs/:orgId/keys', async (req, reply) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, keyBody);
    const exp = b.expiresAt ? new Date(b.expiresAt) : null;
    if (exp && exp <= new Date()) throw bad('INVALID_EXPIRY', 'expiresAt must be in the future.');
    const k = await createKey(db, m.orgId, m.user.id, { agentId: b.agentId, name: b.name, scopes: b.scopes, rateLimitPerMin: b.rateLimitPerMin, expiresAt: exp });
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'api_key.create', targetType: 'api_key', targetId: k.id, detail: { agentId: b.agentId, scopes: b.scopes, environment: k.environment }, ip: ip(req) });
    const row = await one(db, 'SELECT * FROM api_keys WHERE id = $1', [k.id]);
    return reply.status(201).send({ ...keyView(row), key: k.key, notice: 'Store this key now: it is shown only once.' });
  });
  /** Rotation: a new key with the same settings; the old one stays valid for `graceSecs` (default 0). */
  app.post('/v1/orgs/:orgId/keys/:id/rotate', async (req, reply) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ graceSecs: z.number().int().min(0).max(7 * 86_400).default(0) }));
    const old = await one(db, 'SELECT * FROM api_keys WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL', [(req.params as any).id, m.orgId]);
    if (!old) throw notFound('API key');
    const k = await createKey(db, m.orgId, m.user.id, { agentId: old.agent_id, name: old.name, scopes: old.scopes, rateLimitPerMin: old.rate_limit_per_min, expiresAt: old.expires_at }, old.id);
    if (b.graceSecs === 0) await q(db, 'UPDATE api_keys SET revoked_at = now() WHERE id = $1', [old.id]);
    else await q(db, `UPDATE api_keys SET expires_at = LEAST(COALESCE(expires_at, 'infinity'), now() + ($2 || ' seconds')::interval) WHERE id = $1`, [old.id, String(b.graceSecs)]);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'api_key.rotate', targetType: 'api_key', targetId: old.id, detail: { newKeyId: k.id, graceSecs: b.graceSecs }, ip: ip(req) });
    const row = await one(db, 'SELECT * FROM api_keys WHERE id = $1', [k.id]);
    return reply.status(201).send({ ...keyView(row), key: k.key, notice: 'Store this key now: it is shown only once.' });
  });
  app.delete('/v1/orgs/:orgId/keys/:id', async (req) => {
    const m = await member(req, 'ADMIN');
    const id = (req.params as any).id;
    await tx(async (c) => {
      const r = await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL', [id, m.orgId]);
      if (r.rowCount !== 1) throw notFound('API key');
      await audit(c, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'api_key.revoke', targetType: 'api_key', targetId: id, ip: ip(req) });
      await emit(c, m.orgId, 'api_key.revoked', { keyId: id });
    });
    return { id, revoked: true };
  });

  // ------------------------------------------------------------------ evaluations & approvals
  app.post('/v1/orgs/:orgId/agents/:id/evaluate', async (req) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ transaction: z.string().min(80).max(2000), reference: z.string().max(100).optional() }));
    const out = await evaluate(db, { orgId: m.orgId, agentId: (req.params as any).id, transaction: b.transaction, source: 'console', kind: 'evaluate', apiKeyId: null, actorId: m.user.id, reference: b.reference, ip: ip(req) });
    for (const d of out.result.deliveries) await attempt(db, d).catch(() => undefined);
    return out.row;
  });
  app.get('/v1/orgs/:orgId/evaluations', async (req) => {
    const m = await member(req);
    const qs = req.query as any;
    const limit = Math.min(Number(qs.limit) || 50, 200);
    const params: unknown[] = [m.orgId];
    let where = 'org_id = $1';
    if (qs.agentId) { params.push(qs.agentId); where += ` AND agent_id = $${params.length}`; }
    if (qs.decision) { params.push(String(qs.decision)); where += ` AND decision = $${params.length}`; }
    if (qs.pending === '1') where += ` AND approval_status = 'PENDING' AND approval_expires_at > now()`;
    if (qs.before) { params.push(qs.before); where += ` AND created_at < $${params.length}`; }
    params.push(limit);
    const rows = await q(db, `SELECT * FROM evaluations WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map((e) => { const v = evaluationView(e); return { ...v, decoded: undefined, simulation: undefined, checks: undefined }; });
  });
  app.get('/v1/orgs/:orgId/evaluations/:id', async (req) => {
    const m = await member(req);
    return getEvaluation(db, m.orgId, (req.params as any).id);
  });
  for (const action of ['approve', 'reject'] as const) {
    app.post(`/v1/orgs/:orgId/evaluations/:id/${action}`, async (req) => {
      const m = await member(req, 'ADMIN');
      const r = await resolveApproval(db, m.orgId, (req.params as any).id, m.user.id, action === 'approve', ip(req));
      for (const d of r.deliveries) await attempt(db, d).catch(() => undefined);
      return { status: r.status, authorizationIssued: !!r.authorization };
    });
  }

  // ------------------------------------------------------------------ alerts, webhooks, audit, metrics
  app.get('/v1/orgs/:orgId/alerts', async (req) => {
    const m = await member(req);
    return q(db, 'SELECT * FROM alerts WHERE org_id = $1 ORDER BY created_at DESC LIMIT 200', [m.orgId]);
  });
  app.post('/v1/orgs/:orgId/alerts/:id/ack', async (req) => {
    const m = await member(req, 'ADMIN');
    await q(db, 'UPDATE alerts SET acknowledged_by = $3, acknowledged_at = now() WHERE id = $1 AND org_id = $2 AND acknowledged_at IS NULL', [(req.params as any).id, m.orgId, m.user.id]);
    return { ok: true };
  });
  app.get('/v1/orgs/:orgId/webhooks', async (req) => {
    const m = await member(req, 'ADMIN');
    return q(db, 'SELECT id, url, events, disabled_at, created_at FROM webhooks WHERE org_id = $1 ORDER BY created_at', [m.orgId]);
  });
  app.post('/v1/orgs/:orgId/webhooks', async (req, reply) => {
    const m = await member(req, 'ADMIN');
    const b = body(req, z.object({ url: z.string().url().max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }));
    const w = await createWebhook(db, m.orgId, m.user.id, b.url, b.events);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'webhook.create', targetType: 'webhook', targetId: w.id, detail: { url: b.url, events: b.events }, ip: ip(req) });
    return reply.status(201).send({ id: w.id, url: b.url, events: b.events, secret: w.secret, notice: 'Store the signing secret now: it is shown only once.' });
  });
  app.delete('/v1/orgs/:orgId/webhooks/:id', async (req) => {
    const m = await member(req, 'ADMIN');
    await q(db, 'UPDATE webhooks SET disabled_at = now() WHERE id = $1 AND org_id = $2', [(req.params as any).id, m.orgId]);
    await audit(db, { orgId: m.orgId, actorType: 'user', actorId: m.user.id, action: 'webhook.disable', targetType: 'webhook', targetId: (req.params as any).id, ip: ip(req) });
    return { ok: true };
  });
  app.get('/v1/orgs/:orgId/webhooks/:id/deliveries', async (req) => {
    const m = await member(req, 'ADMIN');
    return q(db, 'SELECT id, event, attempts, status, last_status_code, last_error, next_attempt_at, created_at FROM webhook_deliveries WHERE webhook_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 100', [(req.params as any).id, m.orgId]);
  });
  app.post('/v1/orgs/:orgId/webhooks/:id/test', async (req) => {
    const m = await member(req, 'ADMIN');
    const w = await one(db, 'SELECT id FROM webhooks WHERE id = $1 AND org_id = $2 AND disabled_at IS NULL', [(req.params as any).id, m.orgId]);
    if (!w) throw notFound('Webhook');
    const id = newId('dlv');
    await q(db, `INSERT INTO webhook_deliveries(id, org_id, webhook_id, event, payload, status, next_attempt_at) VALUES ($1,$2,$3,'test',$4,'PENDING', now())`,
      [id, m.orgId, w.id, JSON.stringify({ id, type: 'test', createdAt: new Date().toISOString(), organizationId: m.orgId, data: {} })]);
    return { deliveryId: id, status: await attempt(db, id) };
  });
  app.post('/v1/orgs/:orgId/deliveries/:id/redeliver', async (req) => {
    const m = await member(req, 'ADMIN');
    const r = await q(db, `UPDATE webhook_deliveries SET status = 'PENDING', next_attempt_at = now(), attempts = LEAST(attempts, 5) WHERE id = $1 AND org_id = $2 RETURNING id`, [(req.params as any).id, m.orgId]);
    if (!r.length) throw notFound('Delivery');
    return { status: await attempt(db, r[0].id) };
  });
  app.get('/v1/orgs/:orgId/audit', async (req) => {
    const m = await member(req, 'ADMIN');
    const before = Number((req.query as any).before) || Number.MAX_SAFE_INTEGER;
    return q(db, 'SELECT id, actor_type, actor_id, action, target_type, target_id, detail, ip, created_at FROM audit_logs WHERE org_id = $1 AND id < $2 ORDER BY id DESC LIMIT 200', [m.orgId, before]);
  });
  app.get('/v1/orgs/:orgId/metrics', async (req) => {
    const m = await member(req);
    const hours = Math.min(Number((req.query as any).hours) || 24, 24 * 30);
    const [totals, latency, codes, agents, pending] = await Promise.all([
      q(db, `SELECT decision, count(*)::int n FROM evaluations WHERE org_id = $1 AND created_at > now() - ($2 || ' hours')::interval GROUP BY decision`, [m.orgId, String(hours)]),
      one(db, `SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) p95 FROM evaluations WHERE org_id = $1 AND created_at > now() - ($2 || ' hours')::interval`, [m.orgId, String(hours)]),
      q(db, `SELECT r->>'code' code, count(*)::int n FROM evaluations e, jsonb_array_elements(e.reasons) r WHERE e.org_id = $1 AND e.created_at > now() - ($2 || ' hours')::interval GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [m.orgId, String(hours)]),
      q(db, `SELECT agent_id, count(*)::int n, count(*) FILTER (WHERE decision = 'DENY')::int denied FROM evaluations WHERE org_id = $1 AND created_at > now() - ($2 || ' hours')::interval GROUP BY agent_id`, [m.orgId, String(hours)]),
      one(db, `SELECT count(*)::int n FROM evaluations WHERE org_id = $1 AND approval_status = 'PENDING' AND approval_expires_at > now()`, [m.orgId]),
    ]);
    return { windowHours: hours, decisions: Object.fromEntries(totals.map((t) => [t.decision, t.n])), latencyMs: latency, topReasons: codes, agents, pendingApprovals: pending!.n };
  });
}
