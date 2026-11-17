// Build the hand-made landing (site/) into public/, the folder linked to the Vercel project.
// The previous Framer mirror is still reproducible with build.js.
const fs = require('fs');
const path = require('path');
const root = __dirname, src = path.join(root, 'site'), out = path.join(root, 'public');

for (const f of fs.readdirSync(out)) if (f !== '.vercel') fs.rmSync(path.join(out, f), { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true, filter: f => !f.includes('_partials') });
// shared nav/footer
const P = n => fs.readFileSync(path.join(src, '_partials', n + '.html'), 'utf8');
for (const f of fs.readdirSync(out)) if (f.endsWith('.html')) {
  const p = path.join(out, f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('<!--#nav-->', P('nav')).replace('<!--#footer-->', P('footer')));
}
for (const f of ['favicon-32.png', 'favicon-180.png', 'favicon-512.png', 'og.png']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.copyFileSync(path.join(root, 'favicon-32.png'), path.join(out, 'favicon.ico'));
fs.copyFileSync('C:/Users/Utilisateur/intercept-docs/assets/mark.png', path.join(out, 'mark.png'));
fs.copyFileSync(path.join(root, 'vercel.json'), path.join(out, 'vercel.json'));
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ private: true }, null, 2));
fs.writeFileSync(path.join(out, '.vercelignore'), '.env*\nnode_modules\n');
fs.writeFileSync(path.join(out, '.gitignore'), '.vercel\n.env*\n');
// app.intercepting.xyz: separate Vercel project (public-app/), app.html served as the index
const appOut = path.join(root, 'public-app');
fs.mkdirSync(appOut, { recursive: true });
for (const f of fs.readdirSync(appOut)) if (f !== '.vercel') fs.rmSync(path.join(appOut, f), { recursive: true, force: true });
fs.copyFileSync(path.join(out, 'app.html'), path.join(appOut, 'index.html'));
for (const f of ['app.css', 'app.js', 'console.css', 'console.js', 'playground.js', 'site.css', 'gradient.js', 'liquid.frag', 'mark.png', 'favicon.ico', 'favicon-32.png', 'favicon-180.png', 'favicon-512.png', 'og.png', '.vercelignore', '.gitignore']) fs.copyFileSync(path.join(out, f), path.join(appOut, f));
fs.cpSync(path.join(out, 'privy'), path.join(appOut, 'privy'), { recursive: true });
// the API: backend/ (TypeScript, Fastify) is the source; one Vercel function serves /v1/* on
// app.intercepting.xyz and api.intercepting.xyz
const be = path.join(root, 'backend');
for (const d of ['server', 'api']) fs.cpSync(path.join(be, d), path.join(appOut, d), { recursive: true });
const bePkg = JSON.parse(fs.readFileSync(path.join(be, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(appOut, 'package.json'), JSON.stringify({ private: true, engines: { node: '24.x' }, dependencies: bePkg.dependencies, overrides: bePkg.overrides, devDependencies: { '@types/node': bePkg.devDependencies['@types/node'], '@types/pg': bePkg.devDependencies['@types/pg'], typescript: bePkg.devDependencies.typescript } }, null, 2));
fs.copyFileSync(path.join(be, 'tsconfig.json'), path.join(appOut, 'tsconfig.json'));
fs.writeFileSync(path.join(appOut, 'vercel.json'), JSON.stringify({
  cleanUrls: true,
  redirects: [
    { source: '/product', destination: 'https://www.intercepting.xyz/product', permanent: false },
    // api.intercepting.xyz serves the API only
    { source: '/', has: [{ type: 'host', value: 'api.intercepting.xyz' }], destination: '/v1/openapi.json', permanent: false },
    { source: '/:path((?!v1/|api/).*)', has: [{ type: 'host', value: 'api.intercepting.xyz' }], destination: 'https://app.intercepting.xyz/:path', permanent: false },
  ],
  rewrites: [
    { source: '/v1/:path*', destination: '/api/main' },
    { source: '/api/v1/:path*', destination: '/api/main' },
  ],
  functions: { 'api/main.ts': { maxDuration: 30 } },
}, null, 2));
// the marketing site no longer serves the app or its auth API
for (const f of ['app.html', 'app.css', 'app.js', 'console.css', 'console.js', 'playground.js', 'privy']) fs.rmSync(path.join(out, f), { recursive: true, force: true });
console.log('built', fs.readdirSync(out), fs.readdirSync(appOut));
