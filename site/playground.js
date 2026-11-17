// Intercept console · API Playground. Every request goes through POST /v1/orgs/:orgId/playground/request,
// which runs one allowlisted Intercept route in process and sandboxes evaluations (nothing recorded,
// nothing authorized, nothing signed or broadcast). API keys typed here stay in this tab's memory.
(function () {
  const K = window.ixKit;
  if (!K) return;
  const { $, esc, short, usd, ago, toast, copy, crumb, S, VIEWS } = K;
  const API = K.API;

  /* ------------------------------------------------------------------ catalog (real routes only) */
  const TX_BODY = { transaction: '', reference: 'playground-test' };
  const EP = [
    { g: 'Transactions', items: [
      { k: 'evaluate', r: 'agent.evaluate', m: 'POST', p: '/v1/transactions/evaluate', t: 'Evaluate transaction', d: 'Decode, simulate, price and apply the policy of the key\'s agent. Sandboxed here: not recorded, no approval, no alert.', auth: 'key', body: TX_BODY, sandbox: true,
        fields: [['transaction', 'area', 'Serialized transaction, base64 (legacy or v0, signatures may be empty)'], ['reference', 'text', 'Your own id, echoed back']] },
      { k: 'sandbox', r: 'playground.evaluate', m: 'POST', p: '/v1/orgs/{orgId}/playground/evaluate', t: 'Simulate transaction', d: 'The production engine with a chosen agent, a test policy and test assumptions. Console session only.', auth: 'session', sandbox: true,
        body: { network: 'mainnet-beta', transaction: '', policy: { risk: { maxTransactionValueUsd: '1000' }, security: { blockUnknownRecipients: false } } } },
      { k: 'exec', r: 'agent.execution_request', m: 'POST', p: '/v1/execution/requests', t: 'Request execution authorization', d: 'For ENFORCED_EXECUTION agents. In the Playground the decision is computed but no authorization is issued.', auth: 'key', body: TX_BODY, sandbox: true,
        fields: [['transaction', 'area', 'Serialized transaction, base64'], ['reference', 'text', 'Your own id']] },
      { k: 'tx', r: 'agent.transaction', m: 'GET', p: '/v1/transactions/{id}', t: 'Retrieve evaluation', d: 'One evaluation of the key\'s agent, with checks, decoded instructions and simulation.', auth: 'key', params: { id: 'evaluation' } },
      { k: 'txs', r: 'agent.transactions', m: 'GET', p: '/v1/transactions', t: 'List agent evaluations', d: 'Recent evaluations of the key\'s agent, newest first.', auth: 'key', query: [['limit', '20']] },
    ] },
    { g: 'Agents', items: [
      { k: 'self', r: 'agent.self', m: 'GET', p: '/v1/agent', t: 'Retrieve agent (by key)', d: 'The agent, its policy and the key\'s scopes.', auth: 'key' },
      { k: 'agents', r: 'org.agents', m: 'GET', p: '/v1/orgs/{orgId}/agents', t: 'List agents', d: 'Every agent of the organization.', auth: 'session' },
      { k: 'agent', r: 'org.agent', m: 'GET', p: '/v1/orgs/{orgId}/agents/{id}', t: 'Retrieve agent', d: 'One agent with its status, mode, wallet and policy version.', auth: 'session', params: { id: 'agent' } },
      { k: 'activity', r: 'org.evaluations', m: 'GET', p: '/v1/orgs/{orgId}/evaluations', t: 'Retrieve agent activity', d: 'Evaluations of one agent (production only; Playground runs are never listed).', auth: 'session', query: [['agentId', '{agent}'], ['limit', '20']] },
    ] },
    { g: 'Policies', items: [
      { k: 'policies', r: 'org.policies', m: 'GET', p: '/v1/orgs/{orgId}/policies', t: 'Retrieve active policies', d: 'Policies with their current version and configuration.', auth: 'session' },
      { k: 'policy', r: 'org.policy', m: 'GET', p: '/v1/orgs/{orgId}/policies/{id}', t: 'Retrieve policy versions', d: 'A policy and its immutable version history.', auth: 'session', params: { id: 'policy' } },
      { k: 'validate', r: 'policy.validate', m: 'POST', p: '/v1/policies/validate', t: 'Validate policy', d: 'Check a configuration against the schema without saving it.', auth: 'session', body: { config: { risk: { maxTransactionValueUsd: '1000', maxDailySpendUsd: '5000' }, execution: { requireApprovalAboveUsd: '2500' } } } },
      { k: 'violations', r: 'org.evaluations', m: 'GET', p: '/v1/orgs/{orgId}/evaluations', t: 'List policy violations', d: 'Denied production evaluations.', auth: 'session', query: [['decision', 'DENY'], ['limit', '20']] },
      { k: 'defaultpol', r: 'policy.default', m: 'GET', p: '/v1/policy-schema/default', t: 'Default policy', d: 'The configuration new agents start with.', auth: 'none' },
    ] },
    { g: 'Monitoring', items: [
      { k: 'alerts', r: 'org.alerts', m: 'GET', p: '/v1/orgs/{orgId}/alerts', t: 'Retrieve security events', d: 'Alerts raised by evaluations and the wallet tracker.', auth: 'session' },
      { k: 'history', r: 'org.evaluations', m: 'GET', p: '/v1/orgs/{orgId}/evaluations', t: 'Retrieve transaction history', d: 'Production evaluations of the organization.', auth: 'session', query: [['limit', '50']] },
      { k: 'metrics', r: 'org.metrics', m: 'GET', p: '/v1/orgs/{orgId}/metrics', t: 'Retrieve risk metrics', d: 'Decisions, latency, most triggered rules and pending approvals.', auth: 'session', query: [['hours', '24']] },
      { k: 'wallets', r: 'org.wallets', m: 'GET', p: '/v1/orgs/{orgId}/wallets', t: 'List tracked wallets', d: 'Wallets followed by the tracker and their alert rules.', auth: 'session' },
      { k: 'wevents', r: 'org.wallet_events', m: 'GET', p: '/v1/orgs/{orgId}/wallets/{id}/events', t: 'Tracked wallet events', d: 'Transactions seen for one tracked wallet.', auth: 'session', params: { id: 'wallet' } },
      { k: 'feed', r: 'public.feed', m: 'GET', p: '/v1/public/feed', t: 'Live feed', d: 'Public feed of decisions (no authentication).', auth: 'none', query: [['limit', '20']] },
      { k: 'stats', r: 'public.stats', m: 'GET', p: '/v1/public/stats', t: 'Live feed statistics', d: '24 h statistics of the public feed.', auth: 'none' },
      { k: 'pubkeys', r: 'public.keys', m: 'GET', p: '/v1/.well-known/intercept-keys', t: 'Authorization signing keys', d: 'Ed25519 keys that sign execution authorizations.', auth: 'none' },
    ] },
  ];
  const ALL = EP.flatMap(g => g.items);
  const byK = k => ALL.find(e => e.k === k);

  /* ------------------------------------------------------------------ scenarios */
  const TEST_WALLET = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS';
  const TEST_RECIPIENT = 'FmhXnxN8KDDFQExjrAYK6DiipL7sTTPPd78eDojSGRCW';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', JITOSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
  const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  const SYM = { [USDC]: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT', So11111111111111111111111111111111111111112: 'wSOL', [JITOSOL]: 'JitoSOL', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': 'USDC (devnet)' };
  const tok = m => SYM[m] || short(m);
  const pol = (x = {}) => ({ risk: { maxTransactionValueUsd: '1000', ...(x.risk || {}) }, security: { blockUnknownRecipients: false, ...(x.security || {}) }, execution: { failClosed: true, ...(x.execution || {}) } });
  const SC = [
    { k: 'a', t: 'Authorized transaction', d: 'A $500 transfer under a $1,000 per-transaction limit.', exp: 'ALLOW',
      sim: { type: 'native_transfer', to: TEST_RECIPIENT, amountMode: 'usd', amount: '500' }, policy: pol() },
    { k: 'b', t: 'Position limit exceeded', d: 'Buying $25,000 of a token with a $10,000 maximum position.', exp: 'DENY',
      sim: { type: 'swap', mint: USDC, outputMint: JITOSOL, amountMode: 'usd', amount: '25000', slippageBps: '50' }, policy: pol({ risk: { maxTransactionValueUsd: '100000', maxPositionSizeUsd: '10000', maxSlippageBps: 100 } }) },
    { k: 'c', t: 'Unauthorized contract', d: 'A swap through a program that is not in the allowed program list.', exp: 'DENY',
      sim: { type: 'swap', mint: USDC, outputMint: JITOSOL, amountMode: 'usd', amount: '50', slippageBps: '50' }, policy: pol({ security: { allowedPrograms: [ORCA] } }) },
    { k: 'd', t: 'Human approval required', d: 'A $1,500 transfer above the $1,000 automatic approval threshold.', exp: 'REQUIRE_APPROVAL',
      sim: { type: 'native_transfer', to: TEST_RECIPIENT, amountMode: 'usd', amount: '1500' }, policy: pol({ risk: { maxTransactionValueUsd: '5000' }, execution: { requireApprovalAboveUsd: '1000' } }) },
    { k: 'e', t: 'Unlimited token approval', d: 'An allowance of u64 max to a third party. The decision follows the security policy (delegate approvals disallowed here).', exp: 'POLICY',
      sim: { type: 'token_approve', to: TEST_RECIPIENT, mint: USDC, unlimited: true }, policy: pol() },
    { k: 'f', t: 'Daily spending limit', d: 'An $800 transfer with $1,500 already spent and a $2,000 daily limit.', exp: 'DENY',
      sim: { type: 'native_transfer', to: TEST_RECIPIENT, amountMode: 'usd', amount: '800' }, policy: pol({ risk: { maxDailySpendUsd: '2000' } }), assume: '1500' },
  ];

  /* ------------------------------------------------------------------ state */
  const P = VIEWS.playground_state || (VIEWS.playground_state = {
    left: 'endpoints', mode: 'request', ek: 'evaluate', method: 'POST', params: {}, query: [], headers: [], body: '', bodyMode: 'form', subtab: 'body',
    apiKey: '', showKey: false, agentId: '', res: null, resTab: 'response', lang: 'curl', hFilter: '', busy: false, scen: {},
    sim: { input: 'fields', network: 'mainnet-beta', type: 'native_transfer', from: TEST_WALLET, to: TEST_RECIPIENT, mint: USDC, outputMint: JITOSOL, amountMode: 'usd', amount: '500', unlimited: false, slippageBps: '50',
      programId: '', data: '', accounts: '', cuLimit: '', cuPrice: '', memo: '', policyMode: 'custom', policy: JSON.stringify(pol(), null, 2), assume: '', pasted: '' },
  });
  const D = { agents: [], policies: [], wallets: [] };
  const DEC = { ALLOW: ['ok', 'APPROVED'], DENY: ['bad', 'BLOCKED'], REQUIRE_APPROVAL: ['hold', 'REQUIRES APPROVAL'] };
  const decTag = d => d && DEC[d] ? `<span class="pill ${DEC[d][0]}">${DEC[d][1].toLowerCase().replace(/^./, c => c.toUpperCase())}</span>` : '';

  /* ------------------------------------------------------------------ transport */
  async function call(method, path, body) {
    let r;
    try { r = await fetch('/v1' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { return { ok: false, status: 0, json: { error: { code: 'NETWORK_ERROR', message: 'The console could not reach the Intercept API. Check your connection and retry.' } } }; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.reload(); throw new Error('Signed out'); }
    return { ok: r.ok, status: r.status, json: j };
  }
  const org = p => `/orgs/${S.org.id}${p}`;
  /** Runs one request through the executor. Returns a response record for the inspector. */
  async function exec(x) {
    const t0 = performance.now();
    const r = await call('POST', org('/playground/request'), x);
    if (r.ok) return { ...r.json, at: new Date().toISOString(), req: x };
    // the executor refused or failed before the route ran
    return { status: r.status, durationMs: Math.round(performance.now() - t0), sizeBytes: JSON.stringify(r.json).length, requestId: r.json.requestId || null, headers: {}, body: r.json, local: true, at: new Date().toISOString(), req: x, endpoint: null };
  }

  /* ------------------------------------------------------------------ JSON editor */
  function hlJSON(src) {
    return esc(src).replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}\[\],])/g,
      (m, str, colon, lit, num, p) => str ? `<span class="${colon ? 'jk' : 'js'}">${str}</span>${colon || ''}` : lit ? `<span class="jl">${lit}</span>` : num ? `<span class="jn">${num}</span>` : `<span class="jp">${p}</span>`);
  }
  function jsonError(src) {
    if (!src.trim()) return null;
    try { JSON.parse(src); return null; } catch (e) {
      const m = String(e.message);
      let line = null, col = null;
      const lc = m.match(/line (\d+) column (\d+)/);
      const pos = m.match(/position (\d+)/);
      if (lc) { line = +lc[1]; col = +lc[2]; } else if (pos) { const before = src.slice(0, +pos[1]).split('\n'); line = before.length; col = before[before.length - 1].length + 1; }
      return { line, col, msg: m.replace(/^JSON\.parse: /, '').replace(/ in JSON at position \d+.*$/, '').replace(/\s*\(line \d+ column \d+\)/, '') };
    }
  }
  function editor(host, value, onChange, opts = {}) {
    host.innerHTML = `<div class="je${opts.small ? ' sm' : ''}"><div class="je-scroll"><div class="je-gut" aria-hidden="true"></div><div class="je-wrap"><pre class="je-hl" aria-hidden="true"></pre><textarea spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" aria-label="${esc(opts.label || 'JSON')}"></textarea></div></div><div class="je-st"></div></div>`;
    const ta = host.querySelector('textarea'), hl = host.querySelector('.je-hl'), gut = host.querySelector('.je-gut'), st = host.querySelector('.je-st'), wrap = host.querySelector('.je-wrap');
    ta.value = value;
    const paint = () => {
      const v = ta.value;
      hl.innerHTML = hlJSON(v) + '\n';
      const n = v.split('\n').length;
      const err = jsonError(v);
      gut.innerHTML = Array.from({ length: n }, (_, i) => `<span${err && err.line === i + 1 ? ' class="bad"' : ''}>${i + 1}</span>`).join('');
      ta.style.height = '0'; ta.style.width = '0';
      const h = Math.max(ta.scrollHeight, opts.small ? 90 : 160), w = Math.max(ta.scrollWidth, wrap.clientWidth);
      ta.style.height = h + 'px'; ta.style.width = w + 'px'; hl.style.width = w + 'px'; hl.style.height = h + 'px';
      st.className = 'je-st' + (err ? ' bad' : '');
      st.textContent = !v.trim() ? (opts.emptyNote || 'Empty body') : err ? `Invalid JSON${err.line ? ` · line ${err.line}, column ${err.col}` : ''} · ${err.msg}` : `Valid JSON · ${n} line${n > 1 ? 's' : ''}`;
    };
    const insert = txt => { ta.focus(); if (!document.execCommand('insertText', false, txt)) { ta.setRangeText(txt, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); } };
    ta.addEventListener('input', () => { paint(); onChange(ta.value); });
    ta.addEventListener('keydown', e => {
      const v = ta.value, s = ta.selectionStart;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1, ind = v.slice(lineStart).match(/^ */)[0];
      if (e.key === 'Tab') { e.preventDefault(); insert('  '); }
      else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const prev = v.slice(0, s).trimEnd().slice(-1), next = v.slice(ta.selectionEnd).trimStart()[0];
        if ((prev === '{' && next === '}') || (prev === '[' && next === ']')) { insert('\n' + ind + '  \n' + ind); ta.selectionStart = ta.selectionEnd = s + ind.length + 3; }
        else insert('\n' + ind + (prev === '{' || prev === '[' ? '  ' : ''));
      } else if ((e.key === '}' || e.key === ']') && /^\s+$/.test(v.slice(lineStart, s)) && ind.length >= 2) {
        e.preventDefault(); ta.setSelectionRange(s - 2, s); insert(e.key);
      }
    });
    requestAnimationFrame(paint);
    return { get: () => ta.value, set: v => { ta.value = v; paint(); onChange(v); }, focus: () => ta.focus() };
  }

  /* ------------------------------------------------------------------ JSON tree */
  function tree(v, depth = 0, key = null) {
    const k = key === null ? '' : `<span class="jk">${esc(JSON.stringify(key))}</span><span class="jp">: </span>`;
    if (v === null || typeof v !== 'object') {
      const cls = typeof v === 'string' ? 'js' : typeof v === 'number' ? 'jn' : 'jl';
      const s = JSON.stringify(v);
      return `<div class="jt-l">${k}<span class="${cls}">${esc(s.length > 400 ? s.slice(0, 400) + '…"' : s)}</span></div>`;
    }
    const arr = Array.isArray(v), entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
    const [o, c] = arr ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return `<div class="jt-l">${k}<span class="jp">${o}${c}</span></div>`;
    return `<details class="jt"${depth < 2 ? ' open' : ''}><summary>${k}<span class="jp">${o}</span><span class="jt-n">${entries.length} ${arr ? 'item' : 'key'}${entries.length > 1 ? 's' : ''}</span></summary>${entries.map(([kk, x]) => tree(x, depth + 1, arr ? null : kk)).join('')}<div class="jt-l"><span class="jp">${c}</span></div></details>`;
  }

  /* ------------------------------------------------------------------ helpers */
  const ep = () => byK(P.ek) || ALL[0];
  const usesBody = e => e.m === 'POST';
  function loadEndpoint(k, keepRes) {
    const e = byK(k); if (!e) return;
    P.ek = k; P.method = e.m; P.params = {}; P.subtab = usesBody(e) ? 'body' : (e.params ? 'params' : e.query ? 'params' : 'auth');
    P.query = (e.query || []).map(([a, b]) => [a, b === '{agent}' ? (P.agentId || (D.agents[0] || {}).id || '') : b]);
    P.headers = [];
    P.body = e.body ? JSON.stringify(e.body, null, 2) : '';
    if (e.k === 'sandbox' && P.agentId) { const b = JSON.parse(P.body); P.body = JSON.stringify({ agentId: P.agentId, ...b, network: undefined }, null, 2); }
    P.bodyMode = e.fields ? 'form' : 'json';
    if (e.params) for (const [name, kind] of Object.entries(e.params)) P.params[name] = kind === 'agent' ? (P.agentId || (D.agents[0] || {}).id || '') : kind === 'policy' ? ((D.policies[0] || {}).id || '') : kind === 'wallet' ? ((D.wallets[0] || {}).id || '') : '';
    if (!keepRes) P.res = null;
  }
  function resolvePath() {
    const e = ep();
    let missing = null;
    const p = e.p.replace('{orgId}', S.org.id).replace(/\{(\w+)\}/g, (m, n) => { const v = (P.params[n] || '').trim(); if (!v) missing = n; return encodeURIComponent(v); });
    return { path: p, missing };
  }
  const queryObj = () => Object.fromEntries(P.query.filter(([a]) => a.trim()).map(([a, b]) => [a.trim(), b]));
  const headerObj = () => Object.fromEntries(P.headers.filter(([a]) => a.trim()).map(([a, b]) => [a.trim(), b]));
  const agentOf = id => D.agents.find(a => a.id === id);
  const netLabel = n => n === 'mainnet-beta' ? 'mainnet' : n;
  function envNow() {
    const e = ep();
    if (P.mode === 'simulate') { const a = P.sim.policyMode === 'agent' && agentOf(P.agentId); return a ? a.network : P.sim.network; }
    if (e.auth === 'key') { const k = (P.apiKey || '').match(/^icpt_(test|live)_/); return k ? (k[1] === 'live' ? 'mainnet-beta' : 'devnet') : null; }
    const a = agentOf(P.agentId); return a ? a.network : null;
  }

  /* ------------------------------------------------------------------ view */
  VIEWS.playground = async el => {
    crumb(['playground']);
    const [agents, policies, wallets] = await Promise.all([K.get('/agents'), K.get('/policies'), K.get('/wallets').catch(() => [])]);
    D.agents = agents.filter(a => a.status !== 'REVOKED'); D.policies = policies; D.wallets = Array.isArray(wallets) ? wallets : (wallets.items || []);
    if (!P.agentId && D.agents[0]) P.agentId = D.agents[0].id;
    if (!P.body && !P.res) loadEndpoint(P.ek);
    el.innerHTML = `
      <div class="ph pg-ph"><div><span class="pg-eyebrow">Build. Test. Integrate.</span><h1>API Playground</h1><p>Test requests, simulate transactions, and explore the Intercept API in an interactive environment.</p></div>
        <div class="pg-env" id="pg-env"></div></div>
      <div class="pg">
        <section class="card pg-left" aria-label="Endpoints, scenarios and history"><div class="pg-tabs" role="tablist" id="pg-ltabs"></div><div class="pg-scroll" id="pg-lb"></div></section>
        <section class="card pg-mid" aria-label="Request"><div class="pg-tabs" role="tablist" id="pg-mtabs"></div><div class="pg-scroll" id="pg-mb"></div></section>
        <section class="card pg-right" aria-label="Response"><div class="pg-tabs" role="tablist" id="pg-rtabs"></div><div class="pg-scroll" id="pg-rb"></div></section>
      </div>`;
    drawAll();
    loadHistory();
  };
  function drawAll() { drawEnv(); drawLeft(); drawMid(); drawRight(); }
  const tabs = (id, list, cur, on) => {
    const t = $(id); if (!t) return;
    t.innerHTML = list.map(([k, label, extra]) => `<button type="button" role="tab" data-t="${k}" aria-selected="${k === cur}">${label}${extra || ''}</button>`).join('');
    t.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => on(b.dataset.t)));
  };
  function drawEnv() {
    const n = envNow();
    $('#pg-env').innerHTML = `
      <span class="pg-chip" title="Network the next request runs on"><i class="lg-dot ${n === 'mainnet-beta' ? 'c-ok' : n ? 'c-hold' : 'c-fg'}"></i>${n ? `${netLabel(n)} · ${n === 'mainnet-beta' ? 'live data' : 'test network'}` : 'network set by the request'}</span>
      <span class="pg-chip" title="Evaluations are computed by the production engine and are not recorded, approved, alerted or authorized"><svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6L12 3Z"/></svg>Sandbox · nothing signed or broadcast</span>`;
  }

  /* ---------------- left: endpoints / scenarios / history */
  function drawLeft() {
    tabs('#pg-ltabs', [['endpoints', 'Endpoints'], ['scenarios', 'Test scenarios'], ['history', 'History']], P.left, t => { P.left = t; drawLeft(); if (t === 'history') loadHistory(); });
    const b = $('#pg-lb');
    if (P.left === 'endpoints') {
      b.innerHTML = EP.map(g => `<div class="pg-g"><p class="pg-gl">${g.g}</p>${g.items.map(e => `<button type="button" class="pg-ep${P.mode === 'request' && P.ek === e.k ? ' is-on' : ''}" data-ek="${e.k}"><span class="mth ${e.m.toLowerCase()}">${e.m}</span><span class="grow"><b>${esc(e.t)}</b><small>${esc(e.p.replace('/v1/orgs/{orgId}', '…'))}</small></span></button>`).join('')}</div>`).join('');
      b.querySelectorAll('[data-ek]').forEach(x => x.addEventListener('click', () => { loadEndpoint(x.dataset.ek); P.mode = 'request'; drawAll(); }));
    } else if (P.left === 'scenarios') {
      b.innerHTML = `<p class="pg-note">Test scenarios build a real unsigned transaction from a public mainnet wallet and run it through the production engine with an isolated test policy. The expected decision is a description; the result shown is the engine's.</p>
        ${SC.map(s => { const got = P.scen[s.k]; const exp = s.exp === 'POLICY' ? 'Set by policy' : DEC[s.exp][1].toLowerCase();
          return `<div class="pg-sc"><div class="pg-sc-h"><span class="pg-tag">Test · ${s.k.toUpperCase()}</span><b>${esc(s.t)}</b></div><p>${esc(s.d)}</p>
          <div class="pg-sc-r"><span>Expected <em>${exp}</em></span>${got ? `<span>Engine ${decTag(got.decision) || `<em class="bad-t">${esc(got.error || 'error')}</em>`}${got.decision && s.exp !== 'POLICY' ? (got.decision === s.exp ? ' <i class="ok-t">matches</i>' : ' <i class="bad-t">differs</i>') : ''}</span>` : ''}</div>
          <div class="pg-sc-f"><span class="grow"></span><button class="btn btn-ghost btn-xs" data-load="${s.k}">Load</button><button class="btn btn-primary btn-xs" data-run="${s.k}"${P.busy ? ' disabled' : ''}>Run</button></div></div>`; }).join('')}`;
      b.querySelectorAll('[data-load]').forEach(x => x.addEventListener('click', () => { loadScenario(x.dataset.load); drawAll(); }));
      b.querySelectorAll('[data-run]').forEach(x => x.addEventListener('click', () => { loadScenario(x.dataset.run); drawAll(); simulate(x.dataset.run); }));
    } else drawHistory();
  }
  function loadScenario(k) {
    const s = SC.find(x => x.k === k);
    Object.assign(P.sim, { input: 'fields', network: 'mainnet-beta', from: TEST_WALLET, to: '', mint: '', outputMint: '', amount: '', unlimited: false, amountMode: 'usd', slippageBps: '50', programId: '', data: '', accounts: '', memo: '', cuLimit: '', cuPrice: '' }, s.sim);
    P.sim.policyMode = 'custom'; P.sim.policy = JSON.stringify(s.policy, null, 2); P.sim.assume = s.assume || ''; P.sim.scenario = k;
    P.mode = 'simulate';
  }
  const HF = [['', 'All'], ['success', 'Successful'], ['failed', 'Failed'], ['ALLOW', 'Approved'], ['DENY', 'Blocked'], ['REQUIRE_APPROVAL', 'Approval']];
  let HIST = [];
  async function loadHistory() {
    const r = await call('GET', org('/playground/history?limit=100' + (P.hFilter ? '&filter=' + P.hFilter : '')));
    HIST = r.ok ? r.json.items : [];
    if (P.left === 'history') drawHistory();
  }
  function drawHistory() {
    const b = $('#pg-lb'); if (!b) return;
    b.innerHTML = `<div class="pg-hf">${HF.map(([k, t]) => `<button type="button" data-hf="${k}" aria-pressed="${P.hFilter === k}">${t}</button>`).join('')}</div>
      ${HIST.length ? HIST.map(h => { const sc = h.scenario && SC.find(x => 'test-' + x.k === h.scenario); const e = ALL.find(x => x.r === h.endpoint);
        return `<button type="button" class="pg-h" data-h="${h.id}" title="${esc(h.method + ' ' + h.path)}"><span class="mth ${h.method.toLowerCase()}">${h.method}</span><span class="grow"><b>${esc(sc ? `Test ${sc.k.toUpperCase()} · ${sc.t}` : e ? e.t : h.path.split('?')[0])}</b><small><span class="st-i ${h.status < 300 ? 'ok' : h.status < 500 ? 'warn' : 'bad'}">${h.status}</span> · ${ago(h.createdAt)} · ${h.durationMs} ms${h.agentId ? ' · ' + esc((agentOf(h.agentId) || {}).name || short(h.agentId)) : ''}${h.environment ? ' · ' + netLabel(h.environment) : ''}</small></span>${decTag(h.decision)}</button>`; }).join('')
        : `<div class="empty"><b>No requests yet</b>Requests you send from the Playground appear here, for you only. Credentials are never stored.</div>`}
      ${HIST.length ? '<div class="pg-hfoot"><button class="btn btn-ghost btn-xs" id="pg-hclear">Clear history</button></div>' : ''}`;
    b.querySelectorAll('[data-hf]').forEach(x => x.addEventListener('click', () => { P.hFilter = x.dataset.hf; loadHistory(); }));
    b.querySelectorAll('[data-h]').forEach(x => x.addEventListener('click', () => reopen(x.dataset.h)));
    const c = b.querySelector('#pg-hclear');
    c && c.addEventListener('click', async () => { if (!(await K.confirmBox('Clear your Playground history?', 'Your saved requests and responses in this organization are deleted. Production data is not affected.', 'Clear', true))) return; await call('DELETE', org('/playground/history')); loadHistory(); });
  }
  async function reopen(id) {
    const r = await call('GET', org('/playground/history/' + id));
    if (!r.ok) return toast((r.json.error && r.json.error.message) || 'Could not open this request.', true);
    const h = r.json;
    const [path, qs] = h.path.split('?');
    const e = ALL.find(x => x.r === h.endpoint && (!x.query || !qs || x.query.every(([a]) => qs.includes(a + '='))) ) || ALL.find(x => x.r === h.endpoint);
    if (e) {
      loadEndpoint(e.k, true); P.mode = 'request';
      const tpl = e.p.replace('{orgId}', '[^/]+').replace(/\{(\w+)\}/g, '([^/]+)');
      const m = path.match(new RegExp('^' + tpl + '$'));
      const names = [...e.p.matchAll(/\{(\w+)\}/g)].map(x => x[1]).filter(n => n !== 'orgId');
      if (m) names.forEach((n, i) => { P.params[n] = decodeURIComponent(m[i + 1]); });
      P.query = Object.entries((h.request && h.request.query) || {});
      P.headers = Object.entries((h.request && h.request.headers) || {});
      const body = h.request && h.request.body;
      if (body && !body.truncated) { P.body = JSON.stringify(body, null, 2); P.bodyMode = 'json'; }
    }
    const resp = h.response || {};
    P.res = { status: h.status, durationMs: h.durationMs, sizeBytes: resp.sizeBytes, requestId: resp.requestId, headers: resp.headers || {}, body: resp.body, sandboxed: resp.sandboxed, endpoint: h.endpoint, historyId: h.id, at: h.createdAt, fromHistory: true, scenario: h.scenario, auth: h.auth, req: { method: h.method, path } };
    P.resTab = 'response';
    drawAll();
    if (h.auth && h.auth.startsWith('api_key') && !P.apiKey) toast('Keys are never stored: paste the API key again to resend this request.');
  }

  /* ---------------- center: request builder / simulation */
  let ED = null;
  function drawMid() {
    tabs('#pg-mtabs', [['request', 'Request'], ['simulate', 'Simulate transaction']], P.mode, t => { P.mode = t; drawAll(); });
    P.mode === 'simulate' ? drawSim() : drawReq();
  }
  function kvRows(list, kind) {
    return `<div class="pg-kv" data-kv="${kind}">${list.map(([a, b], i) => `<div class="pg-kv-r"><input value="${esc(a)}" data-i="${i}" data-c="0" placeholder="${kind === 'headers' ? 'x-header-name' : 'name'}" aria-label="Name"><input value="${esc(b)}" data-i="${i}" data-c="1" placeholder="value" aria-label="Value"><button type="button" class="mx" data-del="${i}" aria-label="Remove">×</button></div>`).join('')}
      <button type="button" class="pg-add" data-add>+ Add ${kind === 'headers' ? 'header' : 'parameter'}</button></div>`;
  }
  function bindKv(root, kind) {
    const list = kind === 'headers' ? P.headers : P.query;
    const box = root.querySelector(`[data-kv="${kind}"]`); if (!box) return;
    box.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { list[+i.dataset.i][+i.dataset.c] = i.value; }));
    box.querySelectorAll('[data-del]').forEach(x => x.addEventListener('click', () => { list.splice(+x.dataset.del, 1); drawReq(); }));
    box.querySelector('[data-add]').addEventListener('click', () => { list.push(['', '']); drawReq(); });
  }
  function drawReq() {
    const e = ep(), b = $('#pg-mb'), { path } = resolvePath();
    const qs = new URLSearchParams(queryObj()).toString();
    const authNote = { key: 'Agent API key. The agent is the key\'s agent.', session: 'Your console session (this organization).', none: 'Public route, no credentials.' }[e.auth];
    const params = e.params ? Object.entries(e.params) : [];
    const sub = [['body', 'Body', usesBody(e) ? '' : ' <i class="muted">—</i>'], ['params', 'Params', P.query.length + params.length ? ` <i>${P.query.length + params.length}</i>` : ''], ['headers', 'Headers', P.headers.length ? ` <i>${P.headers.length}</i>` : ''], ['auth', 'Auth']];
    b.innerHTML = `
      <div class="pg-line"><select id="pg-m" aria-label="HTTP method">${['GET', 'POST', 'PATCH', 'DELETE'].map(m => `<option${m === P.method ? ' selected' : ''}>${m}</option>`).join('')}</select><div class="pg-url" title="${esc(API + path)}"><span class="muted">${esc(API.replace(/^https?:\/\//, ''))}</span>${esc(path)}${qs ? `<span class="muted">?${esc(qs)}</span>` : ''}</div></div>
      <div class="pg-desc"><b>${esc(e.t)}</b><span>${esc(e.d)}</span><div class="pg-badges"><span class="pg-tag">${e.auth === 'key' ? 'API key' : e.auth === 'session' ? 'Console session' : 'Public'}</span>${e.sandbox ? '<span class="pg-tag hold">Sandboxed in Playground</span>' : ''}${e.m === 'GET' ? '<span class="pg-tag">Read only</span>' : ''}</div></div>
      <div class="pg-sub" role="tablist">${sub.map(([k, t, x]) => `<button type="button" data-s="${k}" aria-selected="${P.subtab === k}">${t}${x || ''}</button>`).join('')}</div>
      <div class="pg-sb" id="pg-sb"></div>
      <div class="pg-foot"><button class="btn btn-ghost btn-xs" id="pg-reset" type="button">Reset</button>${usesBody(e) ? '<button class="btn btn-ghost btn-xs" id="pg-fmt" type="button" title="Alt+Shift+F">Format JSON</button>' : ''}<span class="grow"></span><span class="kbd-h">Ctrl ↵</span><button class="btn btn-primary btn-xs" id="pg-send" type="button"${P.busy ? ' disabled' : ''}>${P.busy ? 'Sending…' : 'Send request'}</button></div>`;
    b.querySelectorAll('[data-s]').forEach(x => x.addEventListener('click', () => { P.subtab = x.dataset.s; drawReq(); }));
    b.querySelector('#pg-m').addEventListener('change', ev => { P.method = ev.target.value; drawReq(); });
    b.querySelector('#pg-reset').addEventListener('click', () => { loadEndpoint(P.ek); drawAll(); });
    const fmt = b.querySelector('#pg-fmt'); fmt && fmt.addEventListener('click', formatBody);
    b.querySelector('#pg-send').addEventListener('click', send);
    const sb = b.querySelector('#pg-sb');
    ED = null;
    if (P.subtab === 'body') {
      if (!usesBody(e)) sb.innerHTML = `<div class="empty sm">${e.m} requests have no body. Use <a href="#" data-go="params">Params</a> for query parameters.</div>`;
      else {
        sb.innerHTML = `${e.fields ? `<div class="pg-bm"><div class="seg"><button type="button" data-bm="form" aria-pressed="${P.bodyMode === 'form'}">Form</button><button type="button" data-bm="json" aria-pressed="${P.bodyMode === 'json'}">Raw JSON</button></div></div>` : ''}<div id="pg-body"></div>
          ${e.k === 'evaluate' || e.k === 'exec' ? '<p class="pg-note">Need a transaction? Build one in <a href="#" data-go="simulate">Simulate transaction</a>, or load a test scenario; its bytes can be sent here with your key.</p>' : ''}`;
        sb.querySelectorAll('[data-bm]').forEach(x => x.addEventListener('click', () => { if (x.dataset.bm === 'form' && jsonError(P.body)) return toast('Fix the JSON first: the form needs a valid body.', true); P.bodyMode = x.dataset.bm; drawReq(); }));
        if (e.fields && P.bodyMode === 'form') drawForm(sb.querySelector('#pg-body'), e);
        else ED = editor(sb.querySelector('#pg-body'), P.body, v => { P.body = v; }, { label: 'Request body' });
      }
    } else if (P.subtab === 'params') {
      sb.innerHTML = `${params.length ? `<h4 class="pg-h4">Path</h4>${params.map(([n, kind]) => `<label class="fld"><span>${n} <small>${kind}</small></span>${pickParam(n, kind)}</label>`).join('')}` : ''}
        <h4 class="pg-h4">Query</h4>${kvRows(P.query, 'query')}${e.r === 'org.evaluations' ? `<p class="pg-note">Pick an agent: <select id="pg-qagent">${D.agents.map(a => `<option value="${a.id}"${(queryObj().agentId || '') === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}<option value="">— none —</option></select></p>` : ''}`;
      sb.querySelectorAll('[data-param]').forEach(x => x.addEventListener('input', () => { P.params[x.dataset.param] = x.value; const { path: pp } = resolvePath(); b.querySelector('.pg-url').innerHTML = `<span class="muted">${esc(API.replace(/^https?:\/\//, ''))}</span>${esc(pp)}`; }));
      sb.querySelectorAll('select[data-param]').forEach(x => x.addEventListener('change', () => { P.params[x.dataset.param] = x.value; if (x.dataset.kind === 'agent') P.agentId = x.value; drawEnv(); drawReq(); }));
      const qa = sb.querySelector('#pg-qagent');
      qa && qa.addEventListener('change', () => { const i = P.query.findIndex(([a]) => a === 'agentId'); if (qa.value) { i >= 0 ? (P.query[i][1] = qa.value) : P.query.unshift(['agentId', qa.value]); P.agentId = qa.value; } else if (i >= 0) P.query.splice(i, 1); drawEnv(); drawReq(); });
      bindKv(sb, 'query');
    } else if (P.subtab === 'headers') {
      const sent = [['Content-Type', usesBody(e) ? 'application/json' : '—'], ['Authorization', e.auth === 'key' ? (P.apiKey ? `Bearer ${P.apiKey.slice(0, 18)}••••••••` : 'not set (see Auth)') : '—'], ['Cookie', e.auth === 'session' ? 'icpt_session=•••••••• (your session)' : '—']];
      sb.innerHTML = `<h4 class="pg-h4">Sent by the Playground</h4><div class="kv card">${sent.map(([a, v]) => `<div>${a}</div><div class="mono">${esc(v)}</div>`).join('')}</div>
        <h4 class="pg-h4">Custom headers <small class="muted">must start with x-</small></h4>${kvRows(P.headers, 'headers')}`;
      bindKv(sb, 'headers');
    } else {
      sb.innerHTML = e.auth === 'key' ? `
        <p class="pg-note" style="margin-top:0">${authNote} <span class="code-tag">icpt_test_</span> keys work with devnet agents, <span class="code-tag">icpt_live_</span> keys with mainnet agents. Intercept only stores a digest of each key, so the full key is never shown again: paste it here, or <a href="#/keys">create one</a>.</p>
        <label class="fld"><span>API key</span><div class="pg-key"><input id="pg-key" type="${P.showKey ? 'text' : 'password'}" autocomplete="off" spellcheck="false" placeholder="icpt_test_…" value="${esc(P.apiKey)}"><button type="button" class="btn btn-ghost btn-xs" id="pg-eye">${P.showKey ? 'Hide' : 'Show'}</button></div><small>Kept in this tab's memory only. Never saved, never logged, never written to history (only its 18-character prefix).</small></label>`
        : `<p class="pg-note" style="margin-top:0">${authNote}</p>${e.auth === 'session' ? `<label class="fld"><span>Agent <small>pre-fills agent identifiers</small></span><select id="pg-agent">${D.agents.map(a => `<option value="${a.id}"${a.id === P.agentId ? ' selected' : ''}>${esc(a.name)} · ${netLabel(a.network)}</option>`).join('') || '<option value="">No agent yet</option>'}</select></label>` : ''}`;
      const ki = sb.querySelector('#pg-key');
      ki && ki.addEventListener('input', () => { P.apiKey = ki.value.trim(); drawEnv(); });
      const eye = sb.querySelector('#pg-eye'); eye && eye.addEventListener('click', () => { P.showKey = !P.showKey; drawReq(); P.subtab = 'auth'; });
      const ag = sb.querySelector('#pg-agent');
      ag && ag.addEventListener('change', () => { P.agentId = ag.value; applyAgent(); drawEnv(); drawReq(); });
    }
    b.querySelectorAll('[data-go]').forEach(x => x.addEventListener('click', ev => { ev.preventDefault(); const g = x.dataset.go; if (g === 'simulate') { P.mode = 'simulate'; drawAll(); } else { P.subtab = g; drawReq(); } }));
  }
  function applyAgent() {
    const e = ep();
    if (e.params) for (const [n, kind] of Object.entries(e.params)) if (kind === 'agent') P.params[n] = P.agentId;
    const i = P.query.findIndex(([a]) => a === 'agentId'); if (i >= 0) P.query[i][1] = P.agentId;
    if (e.k === 'sandbox' && !jsonError(P.body) && P.body.trim()) { const o = JSON.parse(P.body); o.agentId = P.agentId; delete o.network; P.body = JSON.stringify(o, null, 2); }
  }
  function pickParam(n, kind) {
    const list = kind === 'agent' ? D.agents.map(a => [a.id, `${a.name} · ${netLabel(a.network)}`]) : kind === 'policy' ? D.policies.map(p => [p.id, `${p.name} · v${p.currentVersion}`]) : kind === 'wallet' ? D.wallets.map(w => [w.id, `${w.label} · ${short(w.address)}`]) : null;
    if (list && list.length) return `<select data-param="${n}" data-kind="${kind}">${list.map(([v, t]) => `<option value="${v}"${P.params[n] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    return `<input data-param="${n}" value="${esc(P.params[n] || '')}" placeholder="${kind === 'evaluation' ? 'evl_… (from Activity or a previous response)' : kind + ' id'}" spellcheck="false">`;
  }
  function drawForm(host, e) {
    let o = {}; try { o = P.body.trim() ? JSON.parse(P.body) : {}; } catch (_) {}
    host.innerHTML = `<div class="form pg-form">${e.fields.map(([n, kind, hint]) => `<label class="fld full"><span>${n}</span>${kind === 'area' ? `<textarea data-f="${n}" rows="6" class="mono" spellcheck="false" placeholder="${esc(hint)}">${esc(o[n] || '')}</textarea>` : `<input data-f="${n}" value="${esc(o[n] || '')}" placeholder="${esc(hint)}">`}<small>${esc(hint)}</small></label>`).join('')}</div>`;
    host.querySelectorAll('[data-f]').forEach(x => x.addEventListener('input', () => {
      let cur = {}; try { cur = JSON.parse(P.body || '{}'); } catch (_) {}
      if (x.value === '') delete cur[x.dataset.f]; else cur[x.dataset.f] = x.value.trim();
      P.body = JSON.stringify(cur, null, 2);
    }));
  }
  function formatBody() {
    const err = jsonError(P.body);
    if (err) return toast(`Invalid JSON${err.line ? ` at line ${err.line}, column ${err.col}` : ''}: ${err.msg}`, true);
    if (!P.body.trim()) return;
    const v = JSON.stringify(JSON.parse(P.body), null, 2);
    ED ? ED.set(v) : (P.body = v);
  }

  /* simulation builder */
  const TYPES = [['native_transfer', 'Native transfer'], ['token_transfer', 'Token transfer'], ['token_approve', 'Token approval (allowance)'], ['swap', 'Swap (routed contract interaction)'], ['program_call', 'Contract call (program + data)']];
  function drawSim() {
    const s = P.sim, b = $('#pg-mb');
    const agentPol = s.policyMode === 'agent', a = agentPol && agentOf(P.agentId);
    if (a && a.wallet && s.from !== a.wallet) s.from = a.wallet;
    const f = (n, label, extra = '', hint = '') => `<label class="fld${extra.includes('full') ? ' full' : ''}"><span>${label}</span><input data-sf="${n}" value="${esc(s[n] || '')}" spellcheck="false" autocomplete="off" ${extra.replace('full', '')}>${hint ? `<small>${hint}</small>` : ''}</label>`;
    const t = s.type;
    b.innerHTML = `
      ${s.scenario ? `<div class="pg-banner"><span class="pg-tag">Test scenario ${s.scenario.toUpperCase()}</span>${esc((SC.find(x => x.k === s.scenario) || {}).t || '')}<button type="button" class="mx" id="pg-unscen" aria-label="Leave scenario">×</button></div>` : ''}
      <div class="pg-bm"><div class="seg"><button type="button" data-in="fields" aria-pressed="${s.input === 'fields'}">Transaction fields</button><button type="button" data-in="paste" aria-pressed="${s.input === 'paste'}">Paste transaction</button><button type="button" disabled title="Not supported by the engine yet">EVM calldata</button></div></div>
      <p class="pg-note pg-unavail"><b>EVM transactions: unavailable.</b> The engine decodes and simulates this network's transaction format (legacy and v0, lookup tables). EVM calldata, chain ids and gas prices are not supported yet, so they are not offered here.</p>
      ${s.input === 'paste' ? `<label class="fld full"><span>Serialized transaction <small>base64, unsigned</small></span><textarea data-sf="pasted" rows="7" class="mono" spellcheck="false" placeholder="AQAAAAAAAAAA…">${esc(s.pasted)}</textarea></label>` : `
      <div class="form pg-form">
        <label class="fld"><span>Network</span><select data-sf="network"${agentPol ? ' disabled' : ''}><option value="mainnet-beta"${s.network === 'mainnet-beta' ? ' selected' : ''}>mainnet · live state</option><option value="devnet"${s.network === 'devnet' ? ' selected' : ''}>devnet · test network</option></select>${agentPol ? '<small>Set by the agent.</small>' : ''}</label>
        <label class="fld"><span>Transaction type</span><select data-sf="type">${TYPES.map(([v, l]) => `<option value="${v}"${t === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${f('from', 'Sender <small>fee payer, signer</small>', 'full' + (agentPol ? ' readonly' : ''), agentPol ? 'The agent wallet.' : s.from === TEST_WALLET ? 'Public mainnet wallet used for read-only test simulations. Intercept holds no key for it.' : '')}
        ${t !== 'program_call' && t !== 'swap' ? f('to', t === 'token_approve' ? 'Delegate <small>spender</small>' : 'Recipient', 'full') : ''}
        ${t !== 'native_transfer' && t !== 'program_call' ? f('mint', t === 'swap' ? 'Input token mint' : 'Token mint', 'full', s.mint === USDC ? 'USDC' : '') : ''}
        ${t === 'swap' ? f('outputMint', 'Output token mint', 'full', s.outputMint === JITOSOL ? 'JitoSOL' : '') + f('slippageBps', 'Slippage tolerance <small>bps</small>', 'inputmode="numeric"') : ''}
        ${t === 'program_call' ? f('programId', 'Program id <small>contract address</small>', 'full') + f('data', 'Instruction data <small>hex</small>', 'full', 'Encoded instruction bytes (the equivalent of calldata).') + `<label class="fld full"><span>Accounts <small>one per line: address [signer] [writable]</small></span><textarea data-sf="accounts" rows="3" class="mono" spellcheck="false" placeholder="Address writable">${esc(s.accounts)}</textarea></label>` : ''}
        ${t !== 'program_call' && !(t === 'token_approve' && s.unlimited) ? `<label class="fld"><span>Amount</span><div class="pg-amt"><input data-sf="amount" value="${esc(s.amount)}" inputmode="decimal" placeholder="0.0"><select data-sf="amountMode"><option value="usd"${s.amountMode === 'usd' ? ' selected' : ''}>USD</option><option value="units"${s.amountMode === 'units' ? ' selected' : ''}>${t === 'native_transfer' ? 'SOL' : 'token units'}</option></select></div><small>${s.amountMode === 'usd' ? 'Converted at the current market price when the transaction is built.' : 'In whole units, not base units.'}</small></label>` : ''}
        ${t === 'token_approve' ? `<label class="fld"><span>Allowance</span><label class="chk2" style="height:38px"><input type="checkbox" data-sf="unlimited"${s.unlimited ? ' checked' : ''}>Unlimited (u64 max)</label></label>` : ''}
        <details class="full pg-adv"${s.cuLimit || s.cuPrice || s.memo ? ' open' : ''}><summary>Compute budget (gas) and memo</summary><div class="form" style="margin-top:12px">
          ${f('cuLimit', 'Compute unit limit', 'inputmode="numeric" placeholder="200000"')}${f('cuPrice', 'Priority fee <small>micro-lamports / CU</small>', 'inputmode="numeric" placeholder="0"')}${f('memo', 'Memo', 'full maxlength="120"')}</div></details>
      </div>`}
      <h4 class="pg-h4">Policy</h4>
      <div class="pg-bm"><div class="seg"><button type="button" data-pm="custom" aria-pressed="${s.policyMode === 'custom'}">Test policy</button><button type="button" data-pm="agent" aria-pressed="${agentPol}"${D.agents.length ? '' : ' disabled'}>Agent policy</button><button type="button" data-pm="default" aria-pressed="${s.policyMode === 'default'}">Default policy</button></div></div>
      ${agentPol ? `<label class="fld"><span>Agent</span><select id="pg-sagent">${D.agents.map(x => `<option value="${x.id}"${x.id === P.agentId ? ' selected' : ''}>${esc(x.name)} · ${netLabel(x.network)} · policy v${x.policy.version}</option>`).join('')}</select><small>Uses the agent's wallet, network, status and pinned policy version, and its real 24 h spend (read only).</small></label>`
        : s.policyMode === 'custom' ? '<div id="pg-pol"></div><small class="muted">Isolated: used for this request only, never saved. Same schema as <a href="#/policies">Policies</a>.</small>' : '<p class="pg-note">The configuration new agents start with: $1,000 per transaction, $5,000 per day, approval above $2,500, unknown recipients blocked.</p>'}
      <label class="fld" style="margin-top:12px"><span>Assumed spend in the last 24 h <small>USD, optional test input</small></span><input data-sf="assume" value="${esc(s.assume)}" inputmode="decimal" placeholder="${agentPol ? "agent's real 24 h spend" : '0'}"><small>Tests daily limits without touching any spending counter.</small></label>
      <div class="pg-foot"><button class="btn btn-ghost btn-xs" id="pg-sreset" type="button">Reset</button><span class="grow"></span><span class="kbd-h">Ctrl ↵</span><button class="btn btn-primary btn-xs" id="pg-sim" type="button"${P.busy ? ' disabled' : ''}>${P.busy ? 'Simulating…' : s.input === 'paste' ? 'Simulate' : 'Build and simulate'}</button></div>`;
    b.querySelectorAll('[data-sf]').forEach(x => {
      const ev = x.tagName === 'SELECT' || x.type === 'checkbox' ? 'change' : 'input';
      x.addEventListener(ev, () => { s[x.dataset.sf] = x.type === 'checkbox' ? x.checked : x.value; if (ev === 'change') { drawSim(); drawEnv(); } });
    });
    b.querySelectorAll('[data-in]').forEach(x => x.addEventListener('click', () => { s.input = x.dataset.in; drawSim(); }));
    b.querySelectorAll('[data-pm]').forEach(x => x.addEventListener('click', () => { s.policyMode = x.dataset.pm; if (s.policyMode !== 'agent' && agentOf(P.agentId) && s.from === agentOf(P.agentId).wallet) s.from = TEST_WALLET; drawSim(); drawEnv(); }));
    const sa = b.querySelector('#pg-sagent'); sa && sa.addEventListener('change', () => { P.agentId = sa.value; s.from = (agentOf(sa.value) || {}).wallet || s.from; drawSim(); drawEnv(); });
    const pe = b.querySelector('#pg-pol'); if (pe) ED = editor(pe, s.policy, v => { s.policy = v; }, { label: 'Test policy', small: true, emptyNote: 'Empty: every limit unset' });
    const un = b.querySelector('#pg-unscen'); un && un.addEventListener('click', () => { s.scenario = null; drawSim(); });
    b.querySelector('#pg-sreset').addEventListener('click', () => { const sc = s.scenario; if (sc) loadScenario(sc); else Object.assign(s, { type: 'native_transfer', from: TEST_WALLET, to: TEST_RECIPIENT, amountMode: 'usd', amount: '500', policy: JSON.stringify(pol(), null, 2), assume: '' }); drawAll(); });
    b.querySelector('#pg-sim').addEventListener('click', () => simulate(s.scenario || null));
  }
  function buildBody() {
    const s = P.sim, t = s.type;
    const o = { network: s.network, type: t, from: s.from.trim() };
    if (t !== 'program_call' && t !== 'swap' && s.to.trim()) o.to = s.to.trim();
    if ((t === 'token_transfer' || t === 'token_approve' || t === 'swap') && s.mint.trim()) o.mint = s.mint.trim();
    if (t === 'swap') { if (s.outputMint.trim()) o.outputMint = s.outputMint.trim(); if (s.slippageBps) o.slippageBps = Number(s.slippageBps); }
    if (t === 'token_approve' && s.unlimited) o.unlimited = true;
    else if (t !== 'program_call' && s.amount.trim()) o[s.amountMode === 'usd' ? 'amountUsd' : 'amount'] = s.amount.trim();
    if (t === 'program_call') {
      if (s.programId.trim()) o.programId = s.programId.trim();
      if (s.data.trim()) o.data = s.data.trim();
      o.accounts = s.accounts.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [pk, ...fl] = l.split(/\s+/); const f = fl.join(' ').toLowerCase(); return { pubkey: pk, isSigner: /signer/.test(f), isWritable: /writ/.test(f) }; });
    }
    if (s.cuLimit) o.computeUnitLimit = Number(s.cuLimit);
    if (s.cuPrice) o.computeUnitPriceMicroLamports = Number(s.cuPrice);
    if (s.memo) o.memo = s.memo;
    return o;
  }

  async function send() {
    if (P.busy) return;
    const e = ep();
    if (usesBody(e)) { const err = jsonError(P.body); if (err) { P.subtab = 'body'; P.bodyMode = 'json'; drawReq(); return toast(`Invalid JSON${err.line ? ` at line ${err.line}, column ${err.col}` : ''}: ${err.msg}`, true); } }
    const { path, missing } = resolvePath();
    if (missing) { P.subtab = 'params'; drawReq(); return toast(`Fill the path parameter "${missing}".`, true); }
    if (e.auth === 'key' && !P.apiKey) { P.subtab = 'auth'; drawReq(); return toast('Paste an API key in Auth: agent routes authenticate with the agent\'s key.', true); }
    const x = { method: P.method, path, query: queryObj(), headers: headerObj() };
    if (P.method !== 'GET' && P.body.trim()) x.body = JSON.parse(P.body);
    if (e.auth === 'key') x.apiKey = P.apiKey;
    await run(x, 'Sending…');
  }
  async function simulate(scenario) {
    if (P.busy) return;
    const s = P.sim;
    let policy;
    if (s.policyMode === 'custom') {
      const err = jsonError(s.policy); if (err) return toast(`The test policy is not valid JSON${err.line ? ` (line ${err.line})` : ''}: ${err.msg}`, true);
      policy = s.policy.trim() ? JSON.parse(s.policy) : {};
    }
    if (s.policyMode === 'agent' && !P.agentId) return toast('Pick an agent.', true);
    if (s.assume && !/^\d{1,15}(\.\d{1,9})?$/.test(s.assume.trim())) return toast('The assumed 24 h spend must be a USD amount such as 1500.', true);
    P.busy = true; P.res = { loading: s.input === 'paste' ? 'Decoding, simulating and pricing…' : 'Building the transaction, then simulating and pricing…' }; P.resTab = 'response'; drawAll();
    let built = null, tx = s.pasted.trim();
    try {
      if (s.input === 'fields') {
        built = await exec({ method: 'POST', path: `/v1/orgs/${S.org.id}/playground/build`, body: buildBody() });
        if (built.status !== 200) { P.res = { ...built, phase: 'build' }; if (scenario) P.scen[scenario] = { error: (built.body.error || {}).code }; return; }
        tx = built.body.transaction;
      }
      if (!tx) { P.res = null; return toast('Paste a serialized transaction.', true); }
      const body = { transaction: tx };
      if (s.policyMode === 'agent') body.agentId = P.agentId; else { body.network = s.input === 'paste' ? s.network : s.network; if (s.from.trim()) body.wallet = s.from.trim(); }
      if (policy) body.policy = policy;
      if (s.assume.trim()) body.assume = { dailySpendUsd: s.assume.trim() };
      const r = await exec({ method: 'POST', path: `/v1/orgs/${S.org.id}/playground/evaluate`, body, scenario: scenario ? 'test-' + scenario : undefined });
      P.res = { ...r, built: built && built.body, tx, sim: true };
      if (scenario) P.scen[scenario] = r.body && r.body.decision ? { decision: r.body.decision } : { error: (r.body.error || {}).code || 'HTTP ' + r.status };
    } finally { P.busy = false; drawAll(); loadHistory(); }
  }
  async function run(x, label) {
    P.busy = true; P.res = { loading: x.path.includes('evaluate') || x.path.includes('execution') ? 'Decoding, simulating and pricing…' : label }; drawAll();
    try { P.res = await exec(x); }
    finally { P.busy = false; drawAll(); loadHistory(); }
  }

  /* ---------------- right: response inspector */
  function drawRight() {
    const r = P.res;
    tabs('#pg-rtabs', [['response', 'Response'], ['pipeline', 'Pipeline'], ['headers', 'Headers'], ['code', 'Code snippets']], P.resTab, t => { P.resTab = t; drawRight(); });
    const b = $('#pg-rb');
    if (P.resTab === 'code') return drawCode(b);
    if (!r) { b.innerHTML = `<div class="empty"><b>No response yet</b>Pick an endpoint, or run a test scenario, then send the request.<br><span class="kbd-h" style="margin-top:12px;display:inline-block">Ctrl ↵ sends · Alt ⇧ F formats JSON</span></div>`; return; }
    if (r.loading) { b.innerHTML = `<div class="pg-load"><span class="spin"></span>${esc(r.loading)}<small>Simulation reads the current network state; nothing is signed or broadcast.</small></div>`; return; }
    if (P.resTab === 'headers') {
      b.innerHTML = `<h4 class="pg-h4" style="margin-top:0">Response headers</h4><div class="kv card">${Object.entries(r.headers || {}).map(([k, v]) => `<div>${esc(k)}</div><div class="mono">${esc(v)}</div>`).join('') || '<div>—</div><div>None captured</div>'}</div>
        <h4 class="pg-h4">Request</h4><div class="kv card"><div>Method</div><div class="mono">${esc((r.req || {}).method || '')}</div><div>Path</div><div class="mono">${esc((r.req || {}).path || '')}</div><div>Authentication</div><div class="mono">${esc(r.auth || (r.req && r.req.apiKey ? `api_key ${r.req.apiKey.slice(0, 18)}…` : 'session or public'))}</div><div>Recorded as</div><div class="mono">${r.historyId ? esc(r.historyId) + ' (Playground history)' : r.phase === 'build' ? 'not recorded (transaction build)' : '—'}</div></div>`;
      return;
    }
    if (P.resTab === 'pipeline') { b.innerHTML = pipelineHTML(r); bindPipeline(b); return; }
    const body = r.body, sc = r.status, ok = sc >= 200 && sc < 300;
    const err = body && body.error;
    b.innerHTML = `
      <div class="pg-meta"><span class="st ${ok ? 'ok' : sc >= 500 || !sc ? 'bad' : 'warn'}">${sc || '—'} ${statusText(sc)}</span><span>${r.durationMs != null ? r.durationMs + ' ms' : ''}</span><span>${r.sizeBytes != null ? fmtBytes(r.sizeBytes) : ''}</span>${r.requestId ? `<span class="mono" title="Request id">${esc(r.requestId)}</span>` : ''}<span class="grow"></span>${r.sandboxed ? '<span class="pg-tag hold">Sandbox</span>' : ''}${r.fromHistory ? '<span class="pg-tag">From history</span>' : ''}<button class="btn btn-ghost btn-xs" id="pg-copy">Copy</button></div>
      ${r.phase === 'build' ? '<div class="pg-callout bad"><b>The transaction could not be built.</b> Nothing was simulated.</div>' : ''}
      ${err ? errorHTML(r) : ''}
      ${body && body.decision && body.checks ? decisionHTML(body) : ''}
      ${body && body.decision && body.checks ? simulationHTML(body, r) : ''}
      ${r.built && r.built.summary ? builtHTML(r.built, r.tx) : ''}
      <div class="pg-json-h"><h4 class="pg-h4">Body</h4><span class="grow"></span><button class="pg-lnk" data-jt="open">Expand all</button><button class="pg-lnk" data-jt="close">Collapse all</button></div>
      <div class="pg-json">${typeof body === 'string' ? `<pre>${esc(body)}</pre>` : body && body.truncated ? '<p class="muted">The stored response was larger than the history limit and was not kept.</p>' : tree(body)}</div>`;
    b.querySelector('#pg-copy').addEventListener('click', () => copy(typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'Response copied'));
    b.querySelectorAll('[data-jt]').forEach(x => x.addEventListener('click', () => b.querySelectorAll('.pg-json details').forEach(d => { d.open = x.dataset.jt === 'open'; })));
    b.querySelectorAll('[data-copytx]').forEach(x => x.addEventListener('click', () => copy(r.tx, 'Transaction copied')));
    b.querySelectorAll('[data-usekey]').forEach(x => x.addEventListener('click', () => { loadEndpoint('evaluate'); P.body = JSON.stringify({ transaction: r.tx, reference: 'playground-test' }, null, 2); P.mode = 'request'; P.subtab = P.apiKey ? 'body' : 'auth'; drawAll(); }));
    b.querySelectorAll('[data-tab]').forEach(x => x.addEventListener('click', () => { P.resTab = x.dataset.tab; drawRight(); }));
  }
  const statusText = s => ({ 0: 'Network error', 200: 'OK', 201: 'Created', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable', 429: 'Too Many Requests', 500: 'Server Error', 503: 'Unavailable', 504: 'Timeout' })[s] || '';
  const fmtBytes = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
  const HINT = {
    INVALID_API_KEY: 'Paste a valid icpt_test_ or icpt_live_ key in Auth. The full key is shown once at creation; create or rotate one in API keys.',
    API_KEY_REVOKED: 'This key was revoked. Create a new key in API keys.', API_KEY_EXPIRED: 'This key expired. Create a new key or rotate it.', AGENT_REVOKED: 'The key\'s agent is revoked.',
    MISSING_SCOPE: 'Create a key with the missing scope in API keys (rotation keeps the same scopes).',
    ENVIRONMENT_MISMATCH: 'icpt_test_ keys work with devnet agents, icpt_live_ keys with mainnet agents.',
    RATE_LIMITED: 'Wait for the next one-minute window, or raise the key\'s rate limit. The Playground also limits each user to 60 requests per minute.',
    INVALID_REQUEST: 'Fix the fields listed below and send again.', INVALID_POLICY: 'Fix the policy fields listed below; the schema is the one used by Policies.',
    NOT_ENFORCED: 'Execution requests need an agent in ENFORCED_EXECUTION mode (Agents › mode).', NO_POLICY: 'Give the agent a policy in Agents.',
    NOT_FOUND: 'Check the identifier: it must belong to this organization.', BAD_ORIGIN: 'Reload the console and try again.',
    PLAYGROUND_ENDPOINT_NOT_ALLOWED: 'Only the routes listed in Endpoints can be called from the Playground. Administrative routes are not available here.',
    PLAYGROUND_METHOD_NOT_ALLOWED: 'Pick the method listed for this endpoint.', PLAYGROUND_OTHER_ORG: 'Switch organization in the sidebar, or use a key of this organization.',
    PLAYGROUND_HEADER_NOT_ALLOWED: 'Custom headers must start with x-. Credentials are set in Auth.', PLAYGROUND_TIMEOUT: 'The network RPC was slow. Retry; if it persists, the RPC endpoint may be overloaded.',
    PRICE_UNAVAILABLE: 'Market data is temporarily unavailable. Retry, or give the amount in token units.', ROUTE_UNAVAILABLE: 'No swap route right now. Retry or change the tokens.', UPSTREAM_RATE_LIMITED: 'The route provider limits request bursts. Wait a minute and retry.',
    MINT_NOT_FOUND: 'Check the mint address and the network.', NETWORK_ERROR: 'Check your connection and retry.', TX_TOO_LARGE: 'Reduce the number of instructions or accounts.',
  };
  function errorHTML(r) {
    const e = r.body.error;
    const hint = HINT[e.code] || (/^TX_/.test(e.code) ? 'The bytes are not a serialized transaction. Send base64 of a legacy or v0 message; signatures may be empty.' : null);
    const det = Array.isArray(e.details) ? e.details : [];
    return `<div class="pg-callout bad"><span class="code-tag">${esc(e.code)}</span><b>${esc(e.message)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}${det.length ? `<ul>${det.slice(0, 12).map(d => `<li><span class="mono">${esc(d.path || '')}</span> ${esc(d.message || JSON.stringify(d))}</li>`).join('')}</ul>` : ''}${r.local ? '<small>The Playground refused this request before it reached the route.</small>' : ''}</div>`;
  }
  const allChecks = b => [...((b.checks && b.checks.security) || []), ...((b.checks && b.checks.risk) || [])];
  function decisionHTML(b) {
    const [c, label] = DEC[b.decision] || ['mute', b.decision];
    const list = allChecks(b), passed = list.filter(x => x.status === 'PASSED').length, failed = list.filter(x => x.effect !== 'NONE').length, warn = list.filter(x => x.effect === 'NONE' && ['WARNING', 'UNCERTAIN', 'UNSUPPORTED'].includes(x.status)).length;
    const pol = b.policy || {};
    const polText = pol.source === 'custom' ? 'Test policy (isolated)' : pol.source === 'agent' ? `Agent policy v${pol.version}` : pol.source === 'default' ? 'Default policy' : pol.version ? `Policy v${pol.version}` : '';
    const hist = b.history ? (b.history.source === 'assumed' ? `assumed prior 24 h spend ${usd(b.history.dailySpendUsd)} (test input)` : b.history.source === 'agent_24h' ? `agent's real 24 h spend ${usd(b.history.dailySpendUsd)} (read only)` : '') : '';
    const why = b.decision === 'ALLOW' ? 'No rule asked for a block or a review: every configured check passed or did not apply.'
      : b.decision === 'DENY' ? 'At least one rule blocks this transaction. A block cannot be approved by a person.'
        : 'No rule blocks it, but at least one rule asks a person to review it first.';
    return `<div class="pg-dec ${c}"><div class="pg-dec-h"><span class="big ${c}">${label}</span><div><b>${b.valueUsd != null ? usd(b.valueUsd) : 'Value unknown'}</b><small>${[polText, b.network ? netLabel(b.network) : '', hist].filter(Boolean).map(esc).join(' · ')}</small></div><span class="mono muted" title="API value">${esc(b.decision)}</span></div>
      <p class="pg-why">${why}</p>
      <div class="pg-counts"><span><i class="lg-dot c-ok"></i>${passed} passed</span><span><i class="lg-dot c-bad"></i>${failed} with an effect</span><span><i class="lg-dot c-hold"></i>${warn} warning${warn === 1 ? '' : 's'}</span><button class="pg-lnk" data-tab="pipeline">See the pipeline →</button></div>
      ${b.reasons && b.reasons.length ? `<div class="rows pg-reasons">${b.reasons.map(x => `<div class="row"><span class="pill ${x.effect === 'DENY' ? 'bad' : 'hold'}">${x.effect === 'DENY' ? 'blocks' : 'review'}</span><div class="grow"><b>${esc(x.check.replace(/_/g, ' ').toLowerCase().replace(/^./, s => s.toUpperCase()))} <span class="code-tag">${esc(x.code)}</span></b><small>${esc(x.message)}</small></div></div>`).join('')}</div>` : ''}
      ${b.sandbox ? `<p class="pg-fine">${esc(b.notice)}</p>` : b.authorization ? '<p class="pg-fine">This is a production evaluation retrieved from the API.</p>' : ''}</div>`;
  }
  function simulationHTML(b, r) {
    const s = b.simulation, d = b.decoded || {};
    const ins = (d.instructions || []);
    const top = ins.filter(i => i.stackHeight <= 1), inner = ins.length - top.length;
    const approvals = ins.flatMap(i => (i.effects || []).filter(e => e.kind === 'TOKEN_APPROVE' || e.kind === 'TOKEN_REVOKE').map(e => e));
    const sol = s ? s.solChanges || [] : [], tks = s ? s.tokenChanges || [] : [];
    const flows = d.flows || { outflows: [], inflows: [] };
    const secW = ((b.checks && b.checks.security) || []).filter(x => ['FAILED', 'WARNING', 'UNCERTAIN'].includes(x.status));
    const risk = ((b.checks && b.checks.risk) || []).filter(x => x.status !== 'NOT_CONFIGURED' && x.status !== 'NOT_APPLICABLE');
    const lam = v => { const n = Number(v) / 1e9; return (n > 0 ? '+' : '') + n.toLocaleString('en-US', { maximumFractionDigits: 9 }); };
    const st = s ? s.status : 'NOT RUN';
    const changes = [...sol.map(c => `<span class="mono">${short(c.account)}</span> ${lam(c.delta)} SOL`), ...tks.map(c => `<span class="mono">${short(c.owner)}</span> ${Number(c.delta) > 0 ? '+' : ''}${esc(c.delta)} base units of ${esc(tok(c.mint))}${c.created ? ' · account created' : ''}${c.closed ? ' · account closed' : ''}`)];
    return `<div class="pg-simr">
      <div class="pg-simr-h"><h4 class="pg-h4" style="margin:0">Simulation</h4><span class="st ${st === 'SUCCESS' ? 'ok' : st === 'FAILED' ? 'bad' : 'warn'}">${esc(st.toLowerCase())}</span><span class="muted">${s && s.slot ? `slot ${s.slot}` : ''}</span></div>
      <p class="pg-fine">${s && s.status === 'SUCCESS' ? 'Simulated against the current state of the network. This is a prediction, not an on-chain execution: nothing was signed or broadcast.' : s && s.status === 'FAILED' ? 'The transaction fails when simulated against the current state. It would revert on chain.' : `Simulation unavailable${s && s.reason ? ': ' + esc(s.reason) : ''}.`}</p>
      <div class="kv card">
        <div>Agent wallet flows</div><div>${[...flows.outflows.map(f => `−${f.amount != null ? esc(f.amount) : esc(f.raw) + ' base units'} ${f.asset === 'SOL' ? 'SOL' : tok(f.mint)}${f.usd != null ? ` (${usd(f.usd)})` : ''}`), ...flows.inflows.map(f => `+${f.amount != null ? esc(f.amount) : esc(f.raw) + ' base units'} ${f.asset === 'SOL' ? 'SOL' : tok(f.mint)}${f.usd != null ? ` (${usd(f.usd)})` : ''}`)].join('<br>') || 'No balance change'} <small class="muted">(${esc(flows.source || '—')})</small></div>
        <div>Balance changes</div><div>${changes.length ? changes.slice(0, 8).join('<br>') + (changes.length > 8 ? `<br><span class="muted">+ ${changes.length - 8} more in the JSON body</span>` : '') : s && s.status === 'SUCCESS' ? 'None' : 'Unavailable without a successful simulation'}</div>
        <div>Compute consumed</div><div>${s && s.unitsConsumed != null ? `${Number(s.unitsConsumed).toLocaleString('en-US')} compute units` : 'Unavailable'} <small class="muted">(gas)</small></div>
        <div>Allowance changes</div><div>${approvals.length ? approvals.map(a => a.kind === 'TOKEN_REVOKE' ? `Revoke delegate on <span class="mono">${short(a.source)}</span>` : `<span class="mono">${short(a.delegate)}</span> may move ${a.amount === '18446744073709551615' ? '<b class="bad-t">unlimited</b>' : esc(a.amount) + ' base units'}${a.mint ? ` of ${esc(tok(a.mint))}` : ''}`).join('<br>') : 'None'}</div>
        <div>Contract interactions</div><div>${top.map(i => `${esc(i.programName || short(i.program))}${i.supported ? '' : ' <span class="hold-t">(not interpreted)</span>'}`).join(' · ') || '—'}${inner ? ` <small class="muted">+ ${inner} inner</small>` : ''}</div>
        <div>Revert information</div><div>${s && s.status === 'FAILED' ? `<span class="bad-t mono">${esc(JSON.stringify(s.error))}</span>` : s && s.status === 'SUCCESS' ? 'No revert' : '—'}</div>
        <div>Policy violations</div><div>${(b.reasons || []).filter(x => x.effect === 'DENY').map(x => `<span class="code-tag">${esc(x.code)}</span>`).join(' ') || 'None'}</div>
        <div>Financial risk</div><div>${risk.map(x => `${esc(x.check.replace(/_/g, ' ').toLowerCase())}: <span class="${x.effect === 'DENY' ? 'bad-t' : x.effect === 'REQUIRE_APPROVAL' || x.status === 'UNCERTAIN' ? 'hold-t' : ''}">${esc(x.status.toLowerCase())}</span>${x.observed != null ? ` (${esc(x.observed)}${x.limit != null ? ' / ' + esc(x.limit) : ''}${x.unit ? ' ' + esc(x.unit) : ''})` : ''}`).join('<br>') || 'No financial limit configured'}</div>
        <div>Security warnings</div><div>${secW.map(x => `<span class="${x.effect === 'DENY' ? 'bad-t' : 'hold-t'}">${esc(x.check.replace(/_/g, ' ').toLowerCase())}</span>: ${esc(x.reason)}`).join('<br>') || 'None'}</div>
      </div>
      ${s && s.logs && s.logs.length ? `<details class="pg-logs"><summary>Program logs (${s.logs.length})</summary><pre class="snip">${esc(s.logs.slice(-60).join('\n'))}</pre></details>` : ''}
      ${d.issues && d.issues.length ? `<p class="pg-fine">Data notes: ${d.issues.map(esc).join(' · ')}</p>` : ''}
    </div>`;
  }
  function builtHTML(bt, tx) {
    const s = bt.summary;
    const rows = [['Type', s.type], ['From', s.from], s.to && ['To', s.to], s.delegate && ['Delegate', s.delegate], s.mint && ['Token', s.mint], s.outputMint && ['Output token', s.outputMint], s.amount && ['Amount', s.amount], s.price && ['Price used', `${s.price.usd} USD (slot ${s.price.slot})`], s.route && s.route.length && ['Route', s.route.join(' → ')], s.createsDestination && ['Note', 'Creates the recipient token account']].filter(Boolean);
    return `<details class="pg-built"><summary>Built transaction · unsigned · ${tx ? tx.length : 0} chars</summary><div class="kv card">${rows.map(([a, v]) => `<div>${esc(a)}</div><div class="mono">${esc(v)}</div>`).join('')}</div>
      <pre class="snip pg-tx">${esc(tx || '')}</pre><div class="pg-built-a"><button class="btn btn-ghost btn-xs" data-copytx>Copy base64</button><button class="btn btn-ghost btn-xs" data-usekey>Send with an API key →</button></div></details>`;
  }

  /* pipeline */
  const PS = { passed: ['ok', 'Passed'], failed: ['bad', 'Failed'], warning: ['hold', 'Warning'], skipped: ['mute', 'Skipped'], pending: ['mute', 'Pending'], unavailable: ['mute', 'Unavailable'] };
  function agg(list) {
    if (!list.length) return 'skipped';
    if (list.some(c => c.effect === 'DENY')) return 'failed';
    if (list.some(c => c.effect === 'REQUIRE_APPROVAL' || ['WARNING', 'UNCERTAIN', 'UNSUPPORTED'].includes(c.status))) return 'warning';
    if (list.every(c => c.status === 'NOT_CONFIGURED' || c.status === 'NOT_APPLICABLE')) return 'skipped';
    return 'passed';
  }
  const LABEL = {
    MAX_TRANSACTION_VALUE: ['Requested value', 'Threshold'], MAX_DAILY_SPEND: ['Projected 24 h spend', 'Daily limit'], MAX_POSITION_SIZE: ['Projected position', 'Position limit'],
    MAX_PORTFOLIO_EXPOSURE: ['Projected exposure', 'Exposure limit'], MAX_ASSET_CONCENTRATION: ['Projected concentration', 'Limit'], MAX_SLIPPAGE: ['Accepted slippage', 'Limit'], APPROVAL_THRESHOLD: ['Requested value', 'Approval threshold'],
    BLOCKED_PROGRAMS: ['Contract'], ALLOWED_PROGRAMS: ['Contract'], RECIPIENTS: ['Recipient'], BLOCKED_RECIPIENTS: ['Recipient'], DELEGATE_APPROVALS: ['Delegate (permission granted)'], AUTHORITY_CHANGES: ['Operation'],
    UNKNOWN_INSTRUCTIONS: ['Uninterpreted instructions'], RESTRICTED_MINTS: ['Token'], ALLOWED_MINTS: ['Token'], AGENT_WALLET_SIGNER: ['Signers'], SIMULATION: ['Result'],
  };
  function checkDetail(c) {
    const [ol, ll] = LABEL[c.check.split(':')[0]] || ['Observed', 'Limit'];
    const fmt = v => (c.unit === 'USD' ? usd(v) : esc(String(v).split(/,\s*/).map(x => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x) ? x : x).join(', ')) + (c.unit && c.unit !== 'USD' ? ' ' + esc(c.unit) : ''));
    return `<div class="kv card pg-ck">${c.observed != null ? `<div>${ol}</div><div class="mono">${fmt(c.observed)}</div>` : ''}${c.limit != null ? `<div>${ll}</div><div class="mono">${fmt(c.limit)}</div>` : ''}<div>Status</div><div>${esc(c.status.replace(/_/g, ' ').toLowerCase())} · severity ${esc(c.severity.toLowerCase())}</div><div>Effect</div><div>${c.effect === 'DENY' ? '<span class="bad-t">blocks the transaction</span>' : c.effect === 'REQUIRE_APPROVAL' ? '<span class="hold-t">requires a person to approve</span>' : 'none'}</div><div>Reason</div><div>${esc(c.reason)}</div><div>Code</div><div><span class="code-tag">${esc(c.code)}</span></div></div>`;
  }
  function pipelineHTML(r) {
    const b = r.body || {}, sc = r.status, e = b.error;
    const ev = b.decision && b.checks;
    const st = [];
    const reqFail = sc === 400 || sc === 405 || sc === 413 || sc === 422 || (sc === 403 && e && /^PLAYGROUND_/.test(e.code) && e.code !== 'PLAYGROUND_OTHER_ORG');
    st.push({ k: 'Request', s: reqFail ? 'failed' : sc === 0 ? 'unavailable' : 'passed', d: reqFail ? `${e.code}: ${e.message}` : sc === 0 ? 'The API could not be reached.' : 'Method, path, headers and body accepted.' });
    const authFail = sc === 401 || sc === 429 || (sc === 403 && !reqFail) || (sc === 404 && e && e.code === 'NOT_FOUND' && !ev && r.local);
    const sys = ev ? allChecks(b).filter(c => c.category === 'SYSTEM') : [];
    st.push({ k: 'Authentication', s: reqFail || sc === 0 ? 'pending' : authFail ? 'failed' : sys.some(c => c.effect === 'DENY') ? 'failed' : 'passed', checks: sys,
      d: authFail ? `${e.code}: ${e.message}` : ev ? `${b.via === 'api_key' ? 'API key verified, scope and rate limit checked.' : 'Console session and organization membership verified.'} ${sys.length ? '' : 'Agent active, no emergency stop.'}` : reqFail ? 'Not reached.' : 'Credentials accepted.' });
    if (!ev) {
      const why = sc >= 400 ? 'Not reached: the request stopped before the engine ran.' : 'This endpoint does not evaluate a transaction.';
      for (const k of ['Transaction simulation', 'Risk engine', 'Transaction firewall', 'Decision']) st.push({ k, s: sc >= 400 ? 'unavailable' : 'skipped', d: why });
    } else {
      const sec = b.checks.security.filter(c => c.category !== 'SYSTEM');
      const simC = sec.filter(c => c.check === 'SIMULATION');
      const fw = sec.filter(c => c.check !== 'SIMULATION');
      const s = b.simulation;
      st.push({ k: 'Transaction simulation', s: !s ? (simC.some(c => c.effect !== 'NONE') ? 'failed' : 'skipped') : s.status === 'SUCCESS' ? 'passed' : s.status === 'FAILED' ? 'failed' : (simC.some(c => c.effect !== 'NONE') ? 'failed' : 'unavailable'), checks: simC,
        d: s ? (s.status === 'SUCCESS' ? `Simulated at slot ${s.slot}, ${s.unitsConsumed != null ? s.unitsConsumed + ' compute units' : ''}.` : s.status === 'FAILED' ? 'The transaction reverts in simulation.' : 'Simulation unavailable: ' + (s.reason || 'RPC error')) : 'Not run.' });
      st.push({ k: 'Risk engine', s: agg(b.checks.risk), checks: b.checks.risk, d: `${b.checks.risk.filter(c => c.status !== 'NOT_CONFIGURED' && c.status !== 'NOT_APPLICABLE').length} configured financial check(s) on ${b.valueUsd != null ? usd(b.valueUsd) : 'an unknown value'}.` });
      st.push({ k: 'Transaction firewall', s: agg(fw), checks: fw, d: `${fw.length} security rule(s): programs, recipients, tokens, approvals, authorities, unexpected outflows.` });
      st.push({ k: 'Decision', s: b.decision === 'ALLOW' ? 'passed' : b.decision === 'DENY' ? 'failed' : 'warning', d: `${(DEC[b.decision] || [, b.decision])[1]} · ${b.reasons.length} decisive reason(s). Precedence: block > review > allow.` });
    }
    return `<p class="pg-note" style="margin-top:0">Request → Authentication → Transaction simulation → Risk engine → Transaction firewall → Decision. Each stage shows what the API actually did for this response.</p>
      <ol class="pg-pipe">${st.map((x, i) => { const [c, t] = PS[x.s]; const list = (x.checks || []);
        return `<li class="${c}"><div class="pg-pipe-h" ${list.length ? `data-pp="${i}" role="button" tabindex="0" aria-expanded="false"` : ''}><span class="pg-dot"></span><b>${x.k}</b><span class="pill ${c}">${t}</span><span class="grow"></span>${list.length ? `<span class="muted">${list.length} check${list.length > 1 ? 's' : ''} ▾</span>` : ''}</div><p>${esc(x.d)}</p>
          ${list.length ? `<div class="pg-pipe-c" hidden>${list.map((c2, j) => `<details class="pg-cd ${{ PASSED: 'ok', FAILED: 'bad', UNCERTAIN: 'hold', UNSUPPORTED: 'hold', WARNING: 'hold' }[c2.status] || 'mute'}"><summary><span class="pg-dot"></span>${esc(c2.check.replace(/_/g, ' ').toLowerCase())}<span class="grow"></span><span class="muted">${esc(c2.status.replace(/_/g, ' ').toLowerCase())}</span></summary>${checkDetail(c2)}</details>`).join('')}</div>` : ''}</li>`; }).join('')}</ol>`;
  }
  function bindPipeline(b) {
    b.querySelectorAll('[data-pp]').forEach(h => { const tog = () => { const c = h.parentElement.querySelector('.pg-pipe-c'); c.hidden = !c.hidden; h.setAttribute('aria-expanded', String(!c.hidden)); }; h.addEventListener('click', tog); h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tog(); } }); });
  }

  /* code snippets */
  function snippetRequest() {
    // simulation mode: the integration call an agent makes with the built transaction
    if (P.mode === 'simulate') {
      const tx = (P.res && P.res.tx) || '<base64 serialized transaction>';
      return { method: 'POST', url: `${API}/v1/transactions/evaluate`, auth: 'key', body: { transaction: tx }, note: 'Your agent sends the same transaction with its API key. The test policy and assumptions are Playground-only: production uses the agent\'s pinned policy and real counters.' };
    }
    const e = ep(), { path } = resolvePath();
    const qs = new URLSearchParams(queryObj()).toString();
    let body = null; if (e.m !== 'GET' && P.body.trim() && !jsonError(P.body)) body = JSON.parse(P.body);
    return { method: P.method, url: `${API}${path}${qs ? '?' + qs : ''}`, auth: e.auth, body, headers: headerObj(),
      note: e.auth === 'session' ? 'Console route: it authenticates with a signed-in session cookie, not an API key. Agents integrate through the API-key routes.' : e.sandbox ? 'Outside the Playground this request is a production evaluation: it is recorded and counts toward limits.' : null };
  }
  function snippets(x) {
    const H = [];
    if (x.auth === 'key') H.push(['Authorization', 'Bearer ${INTERCEPT_API_KEY}']);
    if (x.auth === 'session') H.push(['Cookie', 'icpt_session=${INTERCEPT_SESSION}']);
    if (x.body) H.push(['Content-Type', 'application/json']);
    for (const [k, v] of Object.entries(x.headers || {})) H.push([k, v]);
    if (x.auth === 'session' && x.method !== 'GET') H.push(['Origin', 'https://app.intercepting.xyz']);
    const bodyStr = x.body ? JSON.stringify(x.body, null, 2) : null;
    const sq = s => "'" + s.replace(/'/g, "'\\''") + "'";
    const curl = [`curl -X ${x.method} ${sq(x.url)}`, ...H.map(([k, v]) => `  -H "${k}: ${v.replace(/\$\{(\w+)\}/g, '$$$1')}"`), ...(bodyStr ? [`  -d ${sq(bodyStr)}`] : [])].join(' \\\n');
    const jsH = H.map(([k, v]) => `    ${JSON.stringify(k)}: ${/\$\{/.test(v) ? '`' + v.replace(/\$\{(\w+)\}/g, '${process.env.$1}') + '`' : JSON.stringify(v)},`).join('\n');
    const jsBody = bodyStr ? `,\n  body: JSON.stringify(${bodyStr.replace(/\n/g, '\n  ')}),` : '';
    const js = `// Node 18+ (global fetch). Never hardcode the key: read it from the environment.\nconst res = await fetch(${JSON.stringify(x.url)}, {\n  method: ${JSON.stringify(x.method)},\n  headers: {\n${jsH}\n  }${jsBody}\n});\nconst data = await res.json();\nif (!res.ok) throw new Error(\`\${data.error.code}: \${data.error.message}\`);\n${/evaluate|execution\/requests/.test(x.url) ? "\nif (data.decision !== 'ALLOW') {\n  // DENY: do not sign. REQUIRE_APPROVAL: wait for a person (poll the evaluation).\n  console.log(data.decision, data.reasons.map((r) => r.code));\n}\n" : 'console.log(data);\n'}`;
    const ts = /evaluate|execution\/requests/.test(x.url)
      ? `type Decision = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';\ninterface Reason { code: string; check: string; effect: 'DENY' | 'REQUIRE_APPROVAL'; message: string }\ninterface Evaluation { id: string; decision: Decision; reasons: Reason[]; valueUsd: string | null; messageHash: string; authorization: { id: string; token?: string; expiresAt: string } | null }\n\nconst res = await fetch(${JSON.stringify(x.url)}, {\n  method: ${JSON.stringify(x.method)},\n  headers: {\n${jsH}\n  }${jsBody}\n});\nconst data = (await res.json()) as Evaluation & { error?: { code: string; message: string } };\nif (!res.ok) throw new Error(\`\${data.error?.code}: \${data.error?.message}\`);\nconst canSign: boolean = data.decision === 'ALLOW';\n`
      : `const res = await fetch(${JSON.stringify(x.url)}, {\n  method: ${JSON.stringify(x.method)},\n  headers: {\n${jsH}\n  }${jsBody}\n});\nconst data: unknown = await res.json();\nif (!res.ok) throw new Error(JSON.stringify(data));\n`;
    const pyH = H.map(([k, v]) => `    ${JSON.stringify(k)}: ${/\$\{/.test(v) ? 'f' + JSON.stringify(v.replace(/\$\{(\w+)\}/g, "{os.environ['$1']}")) : JSON.stringify(v)},`).join('\n');
    const py = `import os\nimport requests\n\nres = requests.request(\n    ${JSON.stringify(x.method)},\n    ${JSON.stringify(x.url)},\n    headers={\n${pyH.replace(/^/gm, '    ')}\n    },${bodyStr ? `\n    json=${bodyStr.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None').replace(/\n/g, '\n    ')},` : ''}\n    timeout=30,\n)\ndata = res.json()\nres.raise_for_status()\n${/evaluate|execution\/requests/.test(x.url) ? "if data['decision'] != 'ALLOW':\n    print(data['decision'], [r['code'] for r in data['reasons']])\n" : 'print(data)\n'}`;
    return { curl, javascript: js, typescript: ts, python: py };
  }
  function drawCode(b) {
    const x = snippetRequest(), s = snippets(x);
    const L = [['curl', 'cURL'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python']];
    b.innerHTML = `<div class="pg-code-h"><div class="seg">${L.map(([k, t]) => `<button type="button" data-lang="${k}" aria-pressed="${P.lang === k}">${t}</button>`).join('')}</div><span class="grow"></span><button class="btn btn-ghost btn-xs" id="pg-ccopy">Copy code</button></div>
      <p class="pg-note"><span class="mth ${x.method.toLowerCase()}">${x.method}</span> <span class="mono">${esc(x.url)}</span>${x.note ? `<br>${esc(x.note)}` : ''}</p>
      <pre class="snip pg-snip">${esc(s[P.lang])}</pre>
      <p class="pg-fine">Credentials are placeholders read from environment variables (INTERCEPT_API_KEY${x.auth === 'session' ? ', INTERCEPT_SESSION' : ''}). No Intercept SDK is published yet: these examples use plain HTTP.</p>`;
    b.querySelectorAll('[data-lang]').forEach(z => z.addEventListener('click', () => { P.lang = z.dataset.lang; drawCode(b); }));
    b.querySelector('#pg-ccopy').addEventListener('click', () => copy(s[P.lang], 'Code copied'));
  }

  /* ---------------- keyboard shortcuts */
  document.addEventListener('keydown', e => {
    if (K.route()[0] !== 'playground' || !$('#modal').hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); P.mode === 'simulate' ? simulate(P.sim.scenario || null) : send(); }
    if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f') && P.mode === 'request') { e.preventDefault(); formatBody(); }
  });
})();
