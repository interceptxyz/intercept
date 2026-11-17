# Intercept API (backend)

Source of the API served at https://api.intercepting.xyz and https://app.intercepting.xyz/v1.
`node ../build-site.js` copies `server/` and `api/main.ts` into `../public-app/` (Vercel project
`intercept-app`), which is what gets deployed. Never edit `public-app/` directly: the build wipes it.

- `server/solana`: transaction decoding (legacy, v0 and lookup tables), simulation, RPC
- `server/market`: Jupiter Price API v3, with a slot-based freshness check
- `server/engine`: evaluation context, plus the risk, firewall and system checks and the decision
- `server/policy`: zod schema and the policy semantics
- `server/services`: identity (Privy), API keys, evaluations and authorizations, webhooks and alerts, audit
- `server/http`: Fastify app, console routes (session + roles), agent routes (API keys), OpenAPI
- `server/db`: Postgres schema (embedded migrations) and helpers

Production environment variables (set on Vercel `intercept-app`):
- `DATABASE_URL` (Neon);
- `PRIVY_APP_ID` and `PRIVY_APP_SECRET`;
- `API_KEY_PEPPER`;
- `AUTHORIZATION_SIGNING_KEY` (Ed25519 PKCS#8, base64);
- `APP_ORIGINS` and `PUBLIC_API_URL`;
- optionally `SOLANA_RPC_MAINNET` and `SOLANA_RPC_DEVNET` (dedicated RPCs recommended).

Tests (Postgres needed; WSL Postgres on 127.0.0.1:5432, role `intercept`):

    npm test                                    # 28 tests: decoder, checks, full API flows
    npx tsx scripts/live-smoke.ts               # real mainnet simulation + prices, no DB
    npx tsx scripts/dev-server.ts               # console + API on http://localhost:3210
    BASE=https://api.intercepting.xyz npx tsx scripts/prod-e2e.ts   # needs prod DATABASE_URL; cleans up

## Intercept Network (threat intelligence)

Code: `server/network/` (model, scoring, lifecycle, service, matching, hooks, chains, providers, analytics) and `server/http/network-routes.ts`; migration `005_network`.

- **Flow**: observation (firewall finding, report, reviewer, external provider) → normalized, deduplicated, rate-limited, on-chain checked → indicator (one per chain + type + value) → confidence (`confidence-v1`, correlation-aware: sources sharing an incident count once) → lifecycle (REPORTED, UNDER_REVIEW, SUSPECTED, VERIFIED, DISPUTED, REVOKED, EXPIRED, FALSE_POSITIVE) → outbox `intelligence_events` → webhooks.
- **Never automatic**: the system can only reach SUSPECTED, with two independent sources. VERIFIED needs reviewers; HIGH and CRITICAL need two different reviewers, and a reporter cannot verify its own report.
- **Privacy**: organizations start `PRIVATE` (observations stay theirs). `ANONYMIZED_INTELLIGENCE` and `AUTHORIZED_CONTRIBUTION` contribute; the registry only returns generated summaries.
- **Firewall**: one check `SEC_NETWORK_THREAT` / `SEC_NETWORK_UNAVAILABLE`; its effect comes from the policy `network` section (verified, suspected, unavailable, minConfidence, minSeverity). No match is reported as "no known match", never as safe. Playground runs read intelligence and write nothing.
- **Chains**: `mainnet-beta`, `devnet` (testnet, isolated) and `eip155:4663` (Robinhood Chain: on-chain evidence, EIP-1967 proxy resolution and lookups; transactions on it are not evaluated by the engine yet).
- **Reviewers**: `npx tsx scripts/grant-reviewer.ts <email|userId> [REVIEWER|LEAD|revoke]` (with `DATABASE_URL`).
- **Tests**: `test/network.test.ts`; production checks `scripts/prod-network.ts`, `scripts/prod-playground.ts`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROBINHOOD_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | JSON-RPC used for evidence (chain id checked) |
| `GOPLUS_ENABLED` | `1` | GoPlus address security as external evidence (Robinhood Chain only) |
| `NETWORK_LOOKUP_TIMEOUT_MS` | `1500` | firewall lookup timeout, then the policy fallback applies |
| `NETWORK_REPORTS_PER_HOUR` / `_PER_DAY` | `30` / `200` | report limits per organization |
| `NETWORK_MIN_COHORT` | `3` | minimum organizations before a count is published |
| `EVM_RPC_TIMEOUT_MS`, `PROVIDER_TIMEOUT_MS` | `6000`, `5000` | outbound timeouts |
