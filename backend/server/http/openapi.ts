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
    '/v1/health': { get: { summary: 'Health', responses: { 200: { description: 'OK' } } } },
  },
};
