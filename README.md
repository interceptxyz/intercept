# Intercept

The risk and security API for autonomous agents. Agents decide. Intercept enforces.

| Path | What |
| --- | --- |
| `site/` | www.intercepting.xyz (landing, /product) and the console (app.html, console.js) |
| `backend/` | API v1 (TypeScript, Fastify, Postgres): see `backend/README.md` |
| `privy-src/` | Privy sign-in island, bundled into `site/privy/` by `node privy-src/build.mjs` |
| `build-site.js` | builds `public/` (www) and `public-app/` (app + API) |
| `make-og.js` | renders `og.png` |

```bash
node build-site.js
cd public && vercel deploy --prod          # www.intercepting.xyz
cd ../public-app && vercel deploy --prod   # app.intercepting.xyz + api.intercepting.xyz
```

`public/` and `public-app/` are generated and must not be edited by hand.
