// Single Vercel function serving the whole Intercept API (Fastify, modular monolith).
// vercel.json rewrites /v1/* and /api/v1/* here; api.intercepting.xyz points at this project.
import type { IncomingMessage, ServerResponse } from 'http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/http/app';

let appPromise: Promise<FastifyInstance> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!appPromise) appPromise = buildApp().catch((e) => { appPromise = null; throw e; });
  const app = await appPromise;
  if (req.url?.startsWith('/api/v1/')) req.url = req.url.slice(4);
  app.server.emit('request', req, res);
}
