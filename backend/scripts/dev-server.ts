// Local preview: static console from ../public-app + the real API on one port.
import http from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { extname, join } from 'path';
import { buildApp } from '../server/http/app';

const ROOT = join(__dirname, '..', '..', 'public-app');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.frag': 'text/plain', '.json': 'application/json' };

buildApp({ logger: false }).then((app) => {
  http.createServer((req, res) => {
    if (req.url!.startsWith('/v1/')) return app.server.emit('request', req, res);
    let p = join(ROOT, decodeURIComponent(req.url!.split('?')[0]));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) p = join(ROOT, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  }).listen(Number(process.env.PORT ?? 3210), () => console.log('dev server on', process.env.PORT ?? 3210));
});
