/**
 * Database schema, applied by migrate(). Embedded as a string so the serverless bundle needs no
 * file access. Every tenant-owned row carries org_id and every query filters on it.
 * Amounts: USD values are NUMERIC(38,9) strings (no floats), token amounts NUMERIC(40,0) base units.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  privy_did     TEXT NOT NULL UNIQUE,
  email         TEXT,
  wallet        TEXT,
  display       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,            -- sha256 of the cookie token
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent  TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  emergency_stop BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','VIEWER')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invitations (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('ADMIN','VIEWER')),
  email       TEXT,
  invited_by  TEXT NOT NULL REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_by TEXT REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policies (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  current_version INT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX policies_org ON policies(org_id);

-- immutable: rows are only ever inserted
CREATE TABLE policy_versions (
  policy_id   TEXT NOT NULL REFERENCES policies(id),
  version     INT NOT NULL,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  config      JSONB NOT NULL,
  config_hash TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, version)
);

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id),
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  wallet           TEXT,
  wallet_verified_at TIMESTAMPTZ,
  network          TEXT NOT NULL CHECK (network IN ('devnet','mainnet-beta')),
  status           TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','REVOKED')),
  integration_mode TEXT NOT NULL CHECK (integration_mode IN ('EVALUATION','ENFORCED_EXECUTION')),
  policy_id        TEXT NOT NULL REFERENCES policies(id),
  policy_version   INT NOT NULL,              -- pinned version; a policy update re-pins explicitly
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ
);
CREATE INDEX agents_org ON agents(org_id);

CREATE TABLE wallet_challenges (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  wallet      TEXT NOT NULL,
  message     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  name         TEXT NOT NULL,
  environment  TEXT NOT NULL CHECK (environment IN ('test','live')),
  prefix       TEXT NOT NULL UNIQUE,         -- non-secret lookup part, e.g. icpt_live_ab12cd34
  digest       TEXT NOT NULL,                -- HMAC-SHA256(server pepper, full key)
  scopes       TEXT[] NOT NULL,
  rate_limit_per_min INT NOT NULL,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  rotated_from TEXT,
  last_used_at TIMESTAMPTZ,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org ON api_keys(org_id);

CREATE TABLE rate_windows (
  key          TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INT NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE evaluations (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  api_key_id      TEXT,
  source          TEXT NOT NULL,              -- api | console
  kind            TEXT NOT NULL,              -- evaluate | execution_request
  network         TEXT NOT NULL,
  policy_id       TEXT NOT NULL,
  policy_version  INT NOT NULL,
  message_hash    TEXT,                       -- sha256 of the serialized message (what gets signed)
  decision        TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY','REQUIRE_APPROVAL')),
  reasons         JSONB NOT NULL,
  risk_checks     JSONB NOT NULL,
  firewall_checks JSONB NOT NULL,
  decoded         JSONB,
  simulation      JSONB,
  value_usd       NUMERIC(38,9),              -- outflow value, null when not priceable
  value_certain   BOOLEAN NOT NULL DEFAULT false,
  client_reference TEXT,
  approval_status TEXT CHECK (approval_status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  approval_expires_at TIMESTAMPTZ,
  resolved_by     TEXT REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  latency_ms      INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evaluations_org ON evaluations(org_id, created_at DESC);
CREATE INDEX evaluations_agent ON evaluations(agent_id, created_at DESC);
CREATE INDEX evaluations_pending ON evaluations(org_id) WHERE approval_status = 'PENDING';

CREATE TABLE authorizations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
  message_hash  TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  signature     TEXT,                         -- on-chain signature reported after execution
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX authorizations_eval ON authorizations(evaluation_id);

CREATE TABLE alerts (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  agent_id    TEXT REFERENCES agents(id),
  evaluation_id TEXT REFERENCES evaluations(id),
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  message     TEXT NOT NULL,
  acknowledged_by TEXT REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alerts_org ON alerts(org_id, created_at DESC);

CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  url         TEXT NOT NULL,
  events      TEXT[] NOT NULL,
  secret      TEXT NOT NULL,                  -- shared HMAC secret, shown once at creation
  disabled_at TIMESTAMPTZ,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  webhook_id  TEXT NOT NULL REFERENCES webhooks(id),
  event       TEXT NOT NULL,
  payload     JSONB NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK (status IN ('PENDING','DELIVERED','FAILED')),
  last_status_code INT,
  last_error  TEXT,
  next_attempt_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'PENDING';

-- append-only
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_org ON audit_logs(org_id, id DESC);
`,
  },
];
