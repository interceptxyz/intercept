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
