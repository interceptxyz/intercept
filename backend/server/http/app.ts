import Fastify, { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { getPool, migrate } from '../db';
import { config } from '../lib/config';
import { HttpError } from '../lib/util';
import { IdentityVerifier, privyVerifier } from '../services/identity';
import { drainDue } from '../services/webhooks';
import { agentRoutes } from './agent-routes';
import { consoleRoutes } from './console-routes';
import { playgroundRoutes } from './playground-routes';
import { OPENAPI } from './openapi';

export interface AppOptions { verifier?: IdentityVerifier; logger?: boolean }

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  config(); // validate configuration at start
  await migrate();
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: process.env.LOG_LEVEL ?? 'info',
      // credentials never reach the logs
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    },
    trustProxy: true,
    bodyLimit: 32 * 1024,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-request-id', req.id);
    // agents call from servers; the console is same-origin. CORS only for the listed origins.
    const origin = req.headers.origin;
    if (origin && config().origins.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'origin');
    }
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE');
      reply.header('access-control-allow-headers', 'authorization,content-type');
      return reply.status(204).send();
    }
  });
  app.addHook('onResponse', async () => {
    if (Math.random() < 0.2) await drainDue(getPool(), 3).catch(() => undefined);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request.', details: err.issues }, requestId: req.id });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message }, requestId: req.id });
    req.log.error({ err }, 'unhandled');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal error.' }, requestId: req.id });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.url.split('?')[0]}` }, requestId: req.id }));

  app.get('/v1/health', async () => {
    await getPool().query('SELECT 1');
    return { ok: true, service: 'intercept-api', version: '1.0.0' };
  });
  app.get('/', async () => ({ service: 'Intercept API', docs: 'https://docs.intercepting.xyz', openapi: '/v1/openapi.json', health: '/v1/health' }));
  app.get('/v1/openapi.json', async () => OPENAPI);
  consoleRoutes(app, opts.verifier ?? privyVerifier);
  agentRoutes(app);
  playgroundRoutes(app);
  await app.ready();
  return app;
}
