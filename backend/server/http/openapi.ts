/** OpenAPI 3.1 description of the public agent API (and the main console endpoints). */
const err = { $ref: '#/components/schemas/Error' };
const evalResp = { description: 'Evaluation recorded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Evaluation' } } } };
const txReq = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TransactionRequest' } } } };
const bearer = [{ apiKey: [] }];
const errors = { 400: { description: 'Invalid request', content: { 'application/json': { schema: err } } }, 401: { description: 'Missing, invalid, revoked or expired key' }, 403: { description: 'Missing scope or environment mismatch' }, 429: { description: 'Rate limited' } };

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Intercept API', version: '1.0.0',
    description: 'Risk and security API for autonomous agents. Agents decide, Intercept enforces.\n\n' +
      'Agents authenticate with `Authorization: Bearer icpt_test_…` (devnet agents) or `icpt_live_…` (mainnet agents). ' +
      'Every transaction is decoded from its bytes, simulated on the agent network, priced, and checked against the agent\'s pinned policy version. ' +
      'Decisions are ALLOW, DENY or REQUIRE_APPROVAL. A decision is enforced only where the execution environment verifies it: in ENFORCED_EXECUTION mode, ' +
      'an ALLOW returns an Ed25519-signed, single-use authorization bound to the transaction message hash.',
  },
  servers: [{ url: 'https://api.intercepting.xyz' }, { url: 'https://app.intercepting.xyz' }],
  components: {
    securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'icpt_<test|live>_<48 chars>' } },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } }, requestId: { type: 'string' } } },
      TransactionRequest: { type: 'object', required: ['transaction'], properties: { transaction: { type: 'string', description: 'Serialized transaction (legacy or v0), base64. Signatures may be empty.' }, reference: { type: 'string', maxLength: 100, description: 'Your own id, echoed back.' } } },
      Check: { type: 'object', properties: { check: { type: 'string' }, code: { type: 'string' }, category: { enum: ['RISK', 'SECURITY', 'SYSTEM'] }, status: { enum: ['PASSED', 'FAILED', 'UNCERTAIN', 'UNSUPPORTED', 'NOT_CONFIGURED', 'NOT_APPLICABLE', 'WARNING'] }, effect: { enum: ['DENY', 'REQUIRE_APPROVAL', 'NONE'] }, severity: { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }, observed: { type: ['string', 'null'] }, limit: { type: ['string', 'null'] }, unit: { type: ['string', 'null'] }, reason: { type: 'string' } } },
      Evaluation: {
        type: 'object',
        properties: {
          id: { type: 'string' }, agentId: { type: 'string' }, kind: { enum: ['evaluate', 'execution_request'] }, network: { enum: ['devnet', 'mainnet-beta'] },
          decision: { enum: ['ALLOW', 'DENY', 'REQUIRE_APPROVAL'] }, effectiveDecision: { enum: ['ALLOW', 'DENY', 'PENDING_APPROVAL'] },
          reasons: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, check: { type: 'string' }, effect: { type: 'string' }, message: { type: 'string' } } } },
          policy: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer' } } },
          valueUsd: { type: ['string', 'null'], description: 'USD value leaving the agent wallet, decimal string; null when it cannot be priced' },
          messageHash: { type: 'string', description: 'sha256 of the serialized message (what the signer signs)' },
          checks: { type: 'object', properties: { risk: { type: 'array', items: { $ref: '#/components/schemas/Check' } }, security: { type: 'array', items: { $ref: '#/components/schemas/Check' } } } },
          authorization: { type: ['object', 'null'], properties: { id: { type: 'string' }, token: { type: 'string' }, expiresAt: { type: 'string' }, messageHash: { type: 'string' } } },
          decoded: { type: 'object' }, simulation: { type: ['object', 'null'] }, latencyMs: { type: 'integer' },
        },
      },
    },
  },
  paths: {
    '/v1/transactions/evaluate': { post: { summary: 'Evaluate a transaction (scope transactions:evaluate)', security: bearer, requestBody: txReq, responses: { 200: evalResp, ...errors } } },
    '/v1/transactions': { get: { summary: 'Recent evaluations of this agent (scope transactions:read)', security: bearer, parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }], responses: { 200: { description: 'List' }, ...errors } } },
    '/v1/transactions/{id}': { get: { summary: 'One evaluation with checks, decoding and simulation (scope transactions:read)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: evalResp, ...errors } } },
    '/v1/execution/requests': { post: { summary: 'Request an execution authorization (scope execution:request, agent in ENFORCED_EXECUTION)', security: bearer, requestBody: txReq, responses: { 200: evalResp, 409: { description: 'Agent not in enforced mode' }, ...errors } } },
    '/v1/execution/requests/{id}': { get: { summary: 'Poll a request; returns authorizationToken once approved', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: evalResp, ...errors } } },
    '/v1/execution/authorizations/{id}/consume': { post: { summary: 'Single-use consumption right before signing', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['messageHash'], properties: { messageHash: { type: 'string' } } } } } }, responses: { 200: { description: 'Consumed' }, 409: { description: 'Mismatch, expired, already used, or agent stopped' } } } },
    '/v1/execution/authorizations/{id}/report': { post: { summary: 'Report the on-chain signature after execution', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Recorded' } } } },
    '/v1/agent': { get: { summary: 'The key\'s agent and its active policy (scope agent:read)', security: bearer, responses: { 200: { description: 'Agent' }, ...errors } } },
    '/v1/.well-known/intercept-keys': { get: { summary: 'Ed25519 public keys that sign execution authorizations', responses: { 200: { description: 'Keys' } } } },
    '/v1/orgs/{orgId}/playground/evaluate': { post: { summary: 'Console session. Sandbox evaluation with the production engine: optional agent, test policy and assumed 24 h spend. Nothing recorded, no approval, alert or authorization.', parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: evalResp } } },
    '/v1/orgs/{orgId}/playground/build': { post: { summary: 'Console session. Build an unsigned test transaction (native/token transfer, token approval, swap route, program call). Never signed or sent.', parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Unsigned transaction (base64) and summary' } } } },
    '/v1/orgs/{orgId}/playground/request': { post: { summary: 'Console session. Run one allowlisted Intercept route in process (API Playground); agent evaluations are sandboxed. Redacted history per user.', parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'status, durationMs, sizeBytes, requestId, headers, body' }, 403: { description: 'Route not allowed or other organization' } } } },
    '/v1/orgs/{orgId}/playground/history': { get: { summary: 'Console session. Your Playground requests (filter=success|failed|ALLOW|DENY|REQUIRE_APPROVAL).', parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'List' } } } },
    '/v1/network/indicators': { get: { summary: 'Intercept Network: shared threat indicators (scope network:read). Filters: chain, type, category, minSeverity, minConfidence, status (default SUSPECTED,VERIFIED), value, updatedSince, before, limit.', security: bearer, responses: { 200: { description: 'items' }, ...errors } } },
    '/v1/network/indicators/{id}': { get: { summary: 'Indicator with shareable evidence summaries, status history and intelligence versions (scope network:read)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Indicator' }, ...errors } } },
    '/v1/network/lookup': { post: { summary: 'Batch lookup (scope network:read): {chain, addresses[], txHashes[], resolveProxies}. status MATCH_FOUND, NO_KNOWN_MATCH (does not mean safe) or INTELLIGENCE_UNAVAILABLE. EIP-1967 proxies resolved on Robinhood Chain (eip155:4663).', security: bearer, responses: { 200: { description: 'Lookup result' }, ...errors } } },
    '/v1/network/reports': { post: { summary: 'Report a security observation (scope network:report): {chain, subject {type, value}, category, txHash?, description?, evidence?}. Private unless the organization shares; never verified automatically.', security: bearer, responses: { 201: { description: 'Report status' }, ...errors } } },
    '/v1/network/reports/{id}': { get: { summary: 'Status of one of your organization reports (scope network:report)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Report' }, ...errors } } },
    '/v1/network/activity': { get: { summary: 'Published intelligence events in sequence order (?after=<intelligenceVersion>&limit&chain): replay and catch-up (scope network:read)', security: bearer, responses: { 200: { description: 'items' } } } },
    '/v1/network/health': { get: { summary: 'Intercept Network health: intelligence version, distribution backlog, provider circuits', responses: { 200: { description: 'Health' } } } },
    '/v1/orgs/{orgId}/network/subscriptions': { get: { summary: 'Console session. Sharing mode and intelligence subscription', parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Settings' } } }, patch: { summary: 'Console session, ADMIN (sharingMode needs OWNER): enabled, minimumConfidence, minimumSeverity, subscribedCategories, deliveryMethod, sharingMode (PRIVATE, ANONYMIZED_INTELLIGENCE, AUTHORIZED_CONTRIBUTION)', parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Settings' } } } },
    '/v1/orgs/{orgId}/network/stats': { get: { summary: 'Console session. Aggregate network statistics (counts withheld below the minimum cohort)', parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Stats' } } } },
    '/v1/admin/network/reviews': { get: { summary: 'Network reviewers only. Review queue with internal evidence', responses: { 200: { description: 'items' }, 403: { description: 'Not a reviewer' } } } },
    '/v1/admin/network/indicators/{id}/{action}': { post: { summary: 'Network reviewers only. action: review, suspect, verify, dispute, revoke, false-positive; body {reason, evidenceRefs?, severity?, category?, publicSummary?}. HIGH and CRITICAL verifications need two different reviewers; reporters cannot verify.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'action', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Indicator' }, 403: { description: 'Not a reviewer or conflict of interest' }, 409: { description: 'Invalid transition or second reviewer required' } } } },
    '/v1/health': { get: { summary: 'Health', responses: { 200: { description: 'OK' } } } },
  },
};
