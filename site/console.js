// Intercept console: hash-routed views over the Intercept API (/v1). Session cookie auth (Privy).
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const short = s => (s && s.length > 16 && !String(s).includes('@') ? s.slice(0, 4) + '…' + s.slice(-4) : s || '');
  const usd = v => (v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const DOCS = 'https://docs.intercepting.xyz';
  const API = location.origin === 'https://app.intercepting.xyz' ? 'https://api.intercepting.xyz' : location.origin;
  const ago = iso => {
    if (!iso) return '—';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const DEC = { ALLOW: ['ok', 'Allowed'], DENY: ['bad', 'Denied'], REQUIRE_APPROVAL: ['hold', 'Approval required'], PENDING_APPROVAL: ['hold', 'Awaiting approval'] };
  const pill = e => {
    const k = e.effectiveDecision || e.decision;
    let [c, t] = DEC[k] || ['mute', k];
    if (e.decision === 'REQUIRE_APPROVAL' && e.approval) {
      if (e.approval.status === 'APPROVED') [c, t] = ['ok', 'Approved by admin'];
      if (e.approval.status === 'REJECTED') [c, t] = ['bad', 'Rejected by admin'];
      if (e.approval.status === 'EXPIRED') [c, t] = ['mute', 'Approval expired'];
    }
    return `<span class="pill ${c}">${t}</span>`;
  };
  const ST = { PASSED: 'pass', FAILED: 'fail', UNCERTAIN: 'warn', UNSUPPORTED: 'warn', WARNING: 'warn', NOT_CONFIGURED: 'skip', NOT_APPLICABLE: 'skip' };
  const I = {
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
    check: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4.5M9.5 4.5h5M9 13h.01M15 13h.01"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    play: '<path d="m21 3-9.5 9.5M21 3l-6.5 18-3-8.5L3 9.5 21 3Z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M16.5 6.5l2.5 2.5M14 9l2 2"/>',
    hook: '<path d="M18 16.5a4 4 0 1 1-4-4h-4l3-7"/><circle cx="6" cy="16.5" r="3.5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
    scroll: '<path d="M8 3h11v15a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2h11v2a3 3 0 0 0 3 3"/><path d="M8 3a3 3 0 0 0-3 3v10M11 8h5M11 12h5"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>',
    term: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  };
  const ic = n => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[n] || ''}</svg>`;
  const NAV = [
    { items: [{ id: 'overview', t: 'Overview', icon: 'grid' }] },
    { label: 'Monitor', items: [{ id: 'activity', t: 'Activity', icon: 'list' }, { id: 'approvals', t: 'Approvals', icon: 'check', count: true }, { id: 'wallets', t: 'Wallets', icon: 'eye' }, { id: 'alerts', t: 'Alerts', icon: 'bell' }] },
    { label: 'Protect', items: [{ id: 'agents', t: 'Agents', icon: 'bot' }, { id: 'policies', t: 'Policies', icon: 'sliders' }, { id: 'evaluate', t: 'Evaluate', icon: 'play' }] },
    { label: 'Developers', items: [{ id: 'playground', t: 'API Playground', icon: 'term' }, { id: 'keys', t: 'API keys', icon: 'key' }, { id: 'webhooks', t: 'Webhooks', icon: 'hook' }, { href: API + '/v1/openapi.json', t: 'OpenAPI', icon: 'book' }] },
    { label: 'Organization', items: [{ id: 'members', t: 'Members', icon: 'users' }, { id: 'audit', t: 'Audit log', icon: 'scroll' }, { id: 'settings', t: 'Settings', icon: 'gear' }] },
  ];
  const VIEWS = {};
  const S = { session: null, org: null, pending: 0 };
  let started = false;
  const admin = () => S.org && (S.org.role === 'OWNER' || S.org.role === 'ADMIN');
  const owner = () => S.org && S.org.role === 'OWNER';

  /* ---------------- data ---------------- */
  async function api(method, path, body) {
    const r = await fetch('/v1' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.reload(); throw new Error('Signed out'); }
    if (!r.ok) {
      const e = new Error((j.error && j.error.message) || 'Request failed.');
      e.details = j.error && j.error.details; e.code = j.error && j.error.code;
      throw e;
    }
    return j;
  }
  const o = p => `/orgs/${S.org.id}${p}`;
  const get = p => api('GET', o(p));
  const post = (p, b) => api('POST', o(p), b || {});
  const issues = e => (Array.isArray(e.details) ? e.details.map(d => `${d.path ? d.path + ': ' : ''}${d.message}`).join(' · ') : e.message);

  /* ---------------- chrome ---------------- */
  function toast(msg, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4200);
  }
  function modal(title, body, mount, wide) {
    const m = $('#modal');
    $('#modal-box').className = 'modal-box' + (wide ? ' wide' : '');
    $('#modal-box').innerHTML = `<div class="card-h"><h2>${esc(title)}</h2><button class="mx" type="button" data-x aria-label="Close">×</button></div><div class="card-b">${body}</div>`;
    m.hidden = false;
    const close = () => { m.hidden = true; $('#modal-box').innerHTML = ''; };
    m.onclick = e => { if (e.target === m || e.target.closest('[data-x]')) close(); };
    mount && mount($('#modal-box'), close);
    const f = $('#modal-box').querySelector('input,select,textarea,button:not([data-x])'); f && f.focus();
    return close;
  }
  const confirmBox = (title, text, label, danger) => new Promise(res => modal(title, `<p class="muted">${text}</p><div class="form-act" style="margin-top:16px"><button class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-xs" id="cf-ok">${label}</button></div>`,
    (box, close) => { box.querySelector('#cf-ok').addEventListener('click', () => { close(); res(true); }); box.querySelector('[data-x]').addEventListener('click', () => res(false)); }));
  const copy = (txt, what) => navigator.clipboard.writeText(txt).then(() => toast((what || 'Copied') + '.'));
  function secretModal(title, text, secret) {
    modal(title, `<p class="muted" style="margin-bottom:14px">${text}</p><div class="secret"><code>${esc(secret)}</code><button class="btn btn-ghost btn-xs" id="sc-cp">Copy</button></div><div class="form-act" style="margin-top:16px"><button class="btn btn-primary btn-xs" data-x>I stored it</button></div>`,
      b => b.querySelector('#sc-cp').addEventListener('click', () => copy(secret)));
  }
  function nav() {
    const [view] = route();
    $('#sb-nav').innerHTML = NAV.map(g => `<div class="sb-g">${g.label ? `<p class="sb-gl">${g.label}</p>` : ''}${g.items.map(it => it.href
      ? `<a class="sb-i" href="${it.href}" target="_blank" rel="noopener" title="${it.t}">${ic(it.icon)}<span>${it.t}</span><em class="ext">↗</em></a>`
      : `<a class="sb-i${view === it.id ? ' is-on' : ''}" href="#/${it.id}" title="${it.t}"${view === it.id ? ' aria-current="page"' : ''}>${ic(it.icon)}<span>${it.t}</span>${it.count && S.pending ? `<em class="count">${S.pending}</em>` : ''}</a>`).join('')}</div>`).join('');
    $('#bell-dot').hidden = !S.pending;
    const sel = $('#org-select');
    sel.innerHTML = S.session.organizations.map(x => `<option value="${x.id}"${x.id === S.org.id ? ' selected' : ''}>${esc(x.name)} · ${x.role.toLowerCase()}</option>`).join('') + '<option value="__new">+ New organization</option>';
    document.body.classList.toggle('org-stopped', !!S.org.emergencyStop);
  }
  function crumb(parts) {
    const item = NAV.flatMap(g => g.items).find(i => i.id === parts[0]);
    $('#crumb').innerHTML = parts.length > 1
      ? `<a href="#/${parts[0]}">${item ? item.t : ''}</a><span>/</span><b>${esc(parts[1])}</b>`
      : `<b>${item ? ic(item.icon) + item.t : ''}</b>`;
    document.title = (parts[parts.length - 1] || 'Console') + ' · Intercept';
  }
  const route = () => (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
  async function refreshPending() {
    try { S.pending = (await get('/metrics?hours=1')).pendingApprovals; } catch (e) { S.pending = 0; }
  }
  async function render() {
    if (!S.org) return;
    const [v, p] = route();
    if (v === 'invite' && p) return acceptInvite(p);
    const fn = VIEWS[v] || VIEWS.overview;
    nav();
    $('#view').innerHTML = `<div class="view-in${v === 'playground' ? ' wide' : ''}"><div class="empty">Loading…</div></div>`;
    $('.shell').classList.remove('is-mobile-open');
    const el = $('#view .view-in');
    try { await fn(el, p); } catch (e) { el.innerHTML = `<div class="card"><div class="empty"><b>Could not load this page</b>${esc(e.message)}<br><button class="btn btn-ghost btn-xs" id="rt">Retry</button></div></div>`; el.querySelector('#rt').onclick = render; }
    $('#view').scrollTop = 0;
    refreshPending().then(nav);
  }
  const stopBanner = () => S.org.emergencyStop ? `<div class="card banner-bad"><b>Emergency stop is active.</b> Every transaction from every agent of this organization is denied. ${owner() ? '<a href="#/settings">Lift it in Settings</a>.' : 'Only an owner can lift it.'}</div>` : '';
  const viewerNote = () => (admin() ? '' : '<div class="note">You have the VIEWER role: you can read everything but not change it.</div>');

  /* ---------------- overview ---------------- */
  VIEWS.overview = async el => {
    crumb(['overview']);
    const [m, recent, agents, keys] = await Promise.all([get('/metrics?hours=168'), get('/evaluations?limit=8'), get('/agents'), get('/keys')]);
    const d = m.decisions, total = (d.ALLOW || 0) + (d.DENY || 0) + (d.REQUIRE_APPROVAL || 0);
    const pct = n => (total ? Math.round((n || 0) / total * 100) + '% of evaluations' : 'No evaluations yet');
    const steps = [
      [agents.length > 0, 'Register an agent', '#/agents'],
      [agents.some(a => a.policy.version > 1), 'Tune its policy', '#/policies'],
      [keys.some(k => !k.revokedAt), 'Create an API key', '#/keys'],
      [total > 0, 'Evaluate a first transaction', '#/evaluate'],
    ];
    const topMax = m.topReasons.length ? m.topReasons[0].n : 1;
    el.innerHTML = `${stopBanner()}
      <div class="ph"><div><h1>Overview</h1><p>Decisions over the last 7 days. Every evaluation decodes the real transaction, simulates it on the agent's network and prices it before applying the policy.</p></div>
      <div class="ph-act"><a class="btn btn-ghost btn-xs" href="#/agents">Agents</a><a class="btn btn-primary btn-xs" href="#/evaluate">Evaluate a transaction</a></div></div>
      <div class="grid4">
        <div class="card stat"><span><i class="lg-dot c-fg"></i>Evaluations · 7 days</span><b>${total}</b><small>${agents.filter(a => a.status !== 'REVOKED').length} agent(s) · latency p50 ${m.latencyMs && m.latencyMs.p50 != null ? m.latencyMs.p50 + ' ms' : '—'}</small></div>
        <div class="card stat"><span><i class="lg-dot c-ok"></i>Allowed</span><b>${d.ALLOW || 0}</b><small>${pct(d.ALLOW)}</small></div>
        <div class="card stat"><span><i class="lg-dot c-bad"></i>Denied</span><b>${d.DENY || 0}</b><small>${pct(d.DENY)}</small></div>
        <div class="card stat"><span><i class="lg-dot c-hold"></i>Awaiting approval</span><b>${m.pendingApprovals}</b><small><a href="#/approvals">Open the queue →</a></small></div>
      </div>
      <div class="grid2">
        <div class="card"><div class="card-h"><h2>Recent evaluations</h2><a href="#/activity">View all</a></div>
          ${recent.length ? `<div class="rows">${recent.map(e => `<a class="row" href="#/activity/${e.id}"><div class="grow"><b>${usd(e.valueUsd)} · ${esc(agentName(agents, e.agentId))}</b><small>${e.reasons.slice(0, 2).map(r => r.code).join(', ') || 'no rule triggered'} · ${ago(e.createdAt)}</small></div>${pill(e)}</a>`).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}
        </div>
        ${steps.every(s => s[0]) ? `<div class="card"><div class="card-h"><h2>Most triggered rules · 7 days</h2><a href="#/policies">Policies</a></div>
          ${m.topReasons.length ? `<div class="rows">${m.topReasons.map(r => `<div class="row"><span class="code-tag">${esc(r.code)}</span><div class="grow"></div><div class="bar"><i style="width:${r.n / topMax * 100}%"></i></div><span class="num">${r.n}</span></div>`).join('')}</div>` : '<div class="empty">No rule has been triggered yet.</div>'}</div>`
        : `<div class="card"><div class="card-h"><h2>Get started</h2><span class="lnk">${steps.filter(s => s[0]).length} / ${steps.length}</span></div>
          <div class="steps">${steps.map((s, i) => `<div class="step${s[0] ? ' done' : ''}"><span class="sn">${s[0] ? '✓' : i + 1}</span><span class="grow">${s[1]}</span>${s[0] ? '' : `<a href="${s[2]}">Start</a>`}</div>`).join('')}</div></div>`}
      </div>`;
  };
  const agentName = (agents, id) => (agents.find(a => a.id === id) || {}).name || short(id);

  /* ---------------- evaluation detail ---------------- */
  function checksTable(list) {
    return `<div class="checks rows">${list.map(c => `<div class="row ${ST[c.status] || 'skip'}"><i class="ic"></i><span class="eng">${esc(c.status.replace('_', ' ').toLowerCase())}</span><div class="grow"><b>${esc(c.check)}</b><small>${esc(c.reason)}</small></div><span class="val">${c.observed != null ? esc(String(c.observed).split(/,\s*/).map(x => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x) ? short(x) : x).join(', ').slice(0, 80)) : ''}${c.limit != null ? ` / ${esc(c.limit)}` : ''}${c.unit ? ' ' + esc(c.unit) : ''}</span></div>`).join('')}</div>`;
  }
  function effectLine(e) {
    const k = e.kind;
    if (k === 'SOL_TRANSFER') return `SOL transfer · ${Number(e.lamports) / 1e9} SOL → <span class="mono">${short(e.to)}</span>`;
    if (k === 'TOKEN_TRANSFER') return `Token transfer · ${esc(e.amount)} base units${e.mint ? ' of <span class="mono">' + short(e.mint) + '</span>' : ''} → account <span class="mono">${short(e.destination)}</span>`;
    if (k === 'TOKEN_APPROVE') return `Delegate approval · <span class="mono">${short(e.delegate)}</span> may move ${esc(e.amount)}`;
    if (k === 'SET_AUTHORITY') return `Authority change · ${esc(e.authorityType)} → <span class="mono">${short(e.newAuthority || 'none')}</span>`;
    if (k === 'SWAP') return `Swap (${esc(e.instruction)}) · slippage tolerance ${e.slippageBps} bps`;
    if (k === 'UNKNOWN') return `Not interpreted · ${esc(e.reason)}`;
    if (k === 'ATA_CREATE') return `Create token account for <span class="mono">${short(e.wallet)}</span>`;
    if (k === 'CLOSE_ACCOUNT') return `Close account → <span class="mono">${short(e.destination)}</span>`;
    if (k === 'COMPUTE_BUDGET') return `Compute budget · ${esc(e.detail)}`;
    return esc(k.toLowerCase().replace(/_/g, ' ') + (e.detail ? ' · ' + e.detail : ''));
  }
  async function evaluationModal(id, onChange) {
    const e = await get('/evaluations/' + id);
    const dec = e.decoded || {}, sim = e.simulation;
    const flows = dec.flows || { outflows: [], inflows: [] };
    const flowRows = (list, sign) => list.map(f => `<div>${sign} ${f.asset === 'SOL' ? 'SOL' : short(f.mint)}</div><div>${f.amount != null ? esc(f.amount) : esc(f.raw) + ' base units'}${f.usd != null ? ` · ${usd(f.usd)}` : ' · unpriced'}${f.price ? `<small class="muted"> @ ${esc(Number(f.price.usd).toFixed(4))} (slot ${f.price.slot}${f.price.reference ? ', mainnet reference' : ''})</small>` : ''}</div>`).join('');
    modal(`Evaluation · ${usd(e.valueUsd)}`, `
      <div class="verdict2" style="padding:0 0 14px;border:0">${pill(e)}<span class="muted" style="font-size:12.5px">${new Date(e.createdAt).toLocaleString()} · ${e.source === 'api' ? 'API key' : 'console'} · ${e.kind === 'execution_request' ? 'execution request' : 'evaluation'} · ${e.network} · policy v${e.policy.version} · ${e.latencyMs} ms</span></div>
      ${e.reasons.length ? `<div class="card"><div class="rows">${e.reasons.map(r => `<div class="row"><span class="code-tag">${esc(r.code)}</span><div class="grow"><small>${esc(r.message)}</small></div><span class="pill ${r.effect === 'DENY' ? 'bad' : 'hold'}">${r.effect === 'DENY' ? 'deny' : 'approval'}</span></div>`).join('')}</div></div>` : ''}
      <h3 class="sub">Asset movements <small class="muted">(${esc(flows.source)})</small></h3>
      <div class="kv card">${flowRows(flows.outflows, '−') || ''}${flowRows(flows.inflows, '+') || ''}${!flows.outflows.length && !flows.inflows.length ? '<div>None</div><div>No balance change for the agent wallet</div>' : ''}</div>
      <h3 class="sub">Security checks</h3>${checksTable(e.checks.security)}
      <h3 class="sub">Risk checks</h3>${checksTable(e.checks.risk)}
      <h3 class="sub">Decoded instructions <small class="muted">${esc(dec.format || '')} · ${dec.complete ? 'complete' : 'incomplete'}</small></h3>
      <div class="card"><div class="rows">${(dec.instructions || []).map(i => `<div class="row"><span class="num" style="width:44px">${i.stackHeight > 1 ? '↳ ' : '#'}${i.index}</span><div class="grow"><b>${esc(i.programName || short(i.program))}</b>${i.effects.map(x => `<small>${effectLine(x)}</small>`).join('')}</div>${i.supported ? '' : '<span class="pill mute">unknown</span>'}</div>`).join('')}</div></div>
      <h3 class="sub">Simulation</h3>
      <div class="kv card">${sim ? `<div>Status</div><div>${esc(sim.status)}${sim.reason ? ' · ' + esc(sim.reason) : ''}</div><div>Slot</div><div>${sim.slot ?? '—'}</div><div>Compute units</div><div>${sim.unitsConsumed ?? '—'}</div><div>Logs</div><div><details><summary>${(sim.logs || []).length} lines</summary><pre class="snip">${esc((sim.logs || []).join('\n'))}</pre></details></div>` : '<div>Status</div><div>Not run</div>'}
        <div>Message hash</div><div class="mono">${esc(e.messageHash)}</div><div>Signers</div><div class="mono">${(dec.signers || []).map(short).join(', ')}</div><div>Evaluation ID</div><div class="mono">${e.id}</div>
        ${e.authorization ? `<div>Authorization</div><div class="mono">${e.authorization.id} · ${e.authorization.consumedAt ? 'used ' + ago(e.authorization.consumedAt) : 'expires ' + new Date(e.authorization.expiresAt).toLocaleTimeString()}${e.authorization.signature ? ' · tx ' + short(e.authorization.signature) : ''}</div>` : ''}
        ${dec.issues && dec.issues.length ? `<div>Notes</div><div>${dec.issues.map(esc).join('<br>')}</div>` : ''}</div>
      ${e.approval && e.approval.status === 'PENDING' && admin() ? `<div class="form-act" style="margin-top:14px"><button class="btn btn-danger btn-xs" data-res="reject">Reject</button><button class="btn btn-primary btn-xs" data-res="approve">Approve</button></div>` : ''}`,
    (box, close) => box.querySelectorAll('[data-res]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await post(`/evaluations/${id}/${b.dataset.res}`); toast(r.status === 'APPROVED' ? (r.authorizationIssued ? 'Approved: an execution authorization was issued.' : 'Approved.') : 'Rejected.'); close(); onChange && onChange(); }
      catch (err) { b.disabled = false; toast(err.message, true); }
    })), true);
  }

  /* ---------------- activity ---------------- */
  VIEWS.activity = async (el, id) => {
    crumb(['activity']);
    const f = VIEWS.activity.f || (VIEWS.activity.f = { decision: '', agentId: '' });
    const agents = await get('/agents');
    const qs = new URLSearchParams({ limit: '200', ...(f.decision ? { decision: f.decision } : {}), ...(f.agentId ? { agentId: f.agentId } : {}) });
    const rows = await get('/evaluations?' + qs);
    el.innerHTML = `
      <div class="ph"><div><h1>Activity</h1><p>Every evaluation, newest first. Open one to see the decoded instructions, the simulation and every check. Test runs from the <a href="#/playground" style="text-decoration:underline;text-underline-offset:3px">API Playground</a> are sandboxed and never listed here.</p></div>
        <div class="filters">
          <select data-f="decision" aria-label="Decision"><option value="">All decisions</option><option value="ALLOW">Allowed</option><option value="DENY">Denied</option><option value="REQUIRE_APPROVAL">Approval required</option></select>
          <select data-f="agentId" aria-label="Agent"><option value="">All agents</option>${agents.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
        </div></div>
      <div class="card">${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Agent</th><th>Value</th><th>Decision</th><th>Triggered</th><th>Source</th><th>Network</th></tr></thead><tbody>
        ${rows.map(e => `<tr class="click" data-id="${e.id}"><td>${ago(e.createdAt)}</td><td class="strong">${esc(agentName(agents, e.agentId))}</td><td class="num">${usd(e.valueUsd)}</td><td>${pill(e)}</td><td>${e.reasons.slice(0, 2).map(r => `<span class="code-tag">${r.code}</span>`).join(' ') || '<span class="muted">—</span>'}</td><td>${e.source === 'api' ? 'API' : 'Console'}</td><td>${e.network}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty"><b>No evaluations</b>Evaluate a transaction from the console or from your agent with its API key.</div>'}</div>`;
    el.querySelectorAll('[data-f]').forEach(s => { s.value = f[s.dataset.f]; s.addEventListener('change', () => { f[s.dataset.f] = s.value; render(); }); });
    el.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => evaluationModal(tr.dataset.id, render).catch(e => toast(e.message, true))));
    if (id) { history.replaceState(null, '', '#/activity'); evaluationModal(id, render).catch(e => toast(e.message, true)); }
  };

  /* ---------------- approvals ---------------- */
  VIEWS.approvals = async el => {
    crumb(['approvals']);
    const [P, agents] = await Promise.all([get('/evaluations?pending=1&limit=100'), get('/agents')]);
    el.innerHTML = `
      <div class="ph"><div><h1>Approvals</h1><p>Transactions that crossed a soft limit wait here. Approving an execution request issues a signed, single-use authorization the agent can pick up; a hard denial can never be approved.</p></div></div>
      ${viewerNote()}
      <div class="card"><div class="card-h"><h2>Awaiting approval</h2><span class="lnk">${P.length}</span></div>
        ${P.length ? `<div class="rows">${P.map(e => `<div class="row"><div class="grow"><b>${usd(e.valueUsd)} · ${esc(agentName(agents, e.agentId))}</b><small>${e.reasons.map(r => esc(r.message)).join(' · ')} · expires ${ago(e.approval.expiresAt).replace(' ago', '')}</small></div>
          <button class="btn btn-ghost btn-xs" data-open="${e.id}">Details</button>${admin() ? `<button class="btn btn-danger btn-xs" data-res="reject" data-id="${e.id}">Reject</button><button class="btn btn-primary btn-xs" data-res="approve" data-id="${e.id}">Approve</button>` : ''}</div>`).join('')}</div>`
        : '<div class="empty"><b>Queue is clear</b>Nothing is waiting for you.</div>'}</div>`;
    el.querySelectorAll('[data-res]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await post(`/evaluations/${b.dataset.id}/${b.dataset.res}`); toast(b.dataset.res === 'approve' ? 'Approved.' : 'Rejected.'); render(); } catch (e) { b.disabled = false; toast(e.message, true); }
    }));
    el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => evaluationModal(b.dataset.open, render)));
  };

  /* ---------------- wallet watchlist ---------------- */
  const RULE_CODES = ['SEC_DELEGATE_APPROVAL', 'SEC_AUTHORITY_CHANGE', 'SEC_UNEXPECTED_OUTFLOW', 'SEC_UNKNOWN_RECIPIENT', 'SEC_UNKNOWN_INSTRUCTION', 'RISK_SLIPPAGE', 'RISK_MAX_TX_VALUE'];
  const DIR = { OUTGOING: ['bad', '↑ Out'], INCOMING: ['ok', '↓ In'], INTERNAL: ['mute', '· Internal'] };
  const rulesText = r => [r.outgoing && 'outgoing', r.incoming && 'incoming', r.onDeny && 'policy denials', r.onApproval && 'approvals', r.failed && 'failed txs', r.codes && r.codes.length && r.codes.length + ' rule code(s)'].filter(Boolean).join(', ') + (r.minValueUsd ? ` · above $${r.minValueUsd}` : '');
  function walletForm(w, policies, onDone) {
    const r = (w && w.rules) || { outgoing: true, incoming: false, minValueUsd: null, onDeny: true, onApproval: true, codes: [], failed: false };
    const chk = (k, t) => `<label class="chk2 full"><input type="checkbox" name="${k}"${r[k] ? ' checked' : ''}>${t}</label>`;
    modal(w ? 'Edit ' + w.label : 'Watch a wallet', `<form class="form" id="wf2">
      ${w ? '' : `<label class="fld full"><span>Wallet address</span><input name="address" class="mono" placeholder="Base58 address" required></label>`}
      <label class="fld"><span>Label</span><input name="label" maxlength="64" value="${esc(w ? w.label : '')}" placeholder="Treasury" required></label>
      ${w ? '' : `<label class="fld"><span>Network</span><select name="network"><option value="mainnet-beta">Mainnet</option><option value="devnet">Devnet</option></select></label>`}
      <label class="fld full"><span>Judge its transactions with</span><select name="policyId"><option value="">Intercept reference policy (trading bot)</option>${policies.map(p => `<option value="${p.id}"${w && w.policyId === p.id ? ' selected' : ''}>${esc(p.name)} · v${p.currentVersion}</option>`).join('')}</select></label>
      <p class="full sect">ALERT ME WHEN</p>
      ${chk('outgoing', 'Value leaves the wallet')}${chk('incoming', 'Value arrives in the wallet')}
      <label class="fld full"><span>Only above <small>USD, applies to the two lines above</small></span><input name="minValueUsd" inputmode="decimal" placeholder="any amount" value="${esc(r.minValueUsd || '')}"></label>
      ${chk('onDeny', 'The policy would deny the transaction')}${chk('onApproval', 'The policy would require approval')}${chk('failed', 'A transaction fails onchain')}
      <div class="fld full"><span>Always alert on these rules</span>${RULE_CODES.map(c => `<label class="chk2"><input type="checkbox" name="code" value="${c}"${(r.codes || []).includes(c) ? ' checked' : ''}><span class="code-tag">${c}</span></label>`).join('')}</div>
      <p class="err full" id="wf2-err"></p>
      <div class="form-act full"><button type="button" class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn btn-primary btn-xs">${w ? 'Save' : 'Start watching'}</button></div></form>`,
    (box, close) => box.querySelector('#wf2').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, fd = new FormData(f);
      const min = String(fd.get('minValueUsd') || '').trim();
      const rules = { outgoing: f.outgoing.checked, incoming: f.incoming.checked, minValueUsd: min || null, onDeny: f.onDeny.checked, onApproval: f.onApproval.checked, failed: f.failed.checked, codes: fd.getAll('code') };
      const btn = f.querySelector('button:not([data-x])'); btn.disabled = true; btn.textContent = w ? 'Saving…' : 'Reading recent history…';
      try {
        const out = w ? await api('PATCH', o('/wallets/' + w.id), { label: fd.get('label'), policyId: fd.get('policyId') || null, rules })
          : await post('/wallets', { address: String(fd.get('address')).trim(), label: fd.get('label'), network: fd.get('network'), policyId: fd.get('policyId') || null, rules });
        close(); toast(w ? 'Saved.' : 'Watching ' + out.label + '.'); onDone(out);
      } catch (err) { box.querySelector('#wf2-err').textContent = issues(err); btn.disabled = false; btn.textContent = w ? 'Save' : 'Start watching'; }
    }), true);
  }
  VIEWS.wallets = async (el, id) => {
    if (id) return walletDetail(el, id);
    crumb(['wallets']);
    const [W, policies] = await Promise.all([get('/wallets'), get('/policies')]);
    el.innerHTML = `
      <div class="ph"><div><h1>Wallets</h1><p>Follow any wallet. Every new transaction is read from the chain and judged on what it actually did, with the policy you choose. Alerts land in <a href="#/alerts">Alerts</a> and in your webhooks (<span class="code-tag">alert.created</span>).</p></div>
        <div class="ph-act">${admin() ? '<button class="btn btn-primary btn-xs" id="nw2">Watch a wallet</button>' : ''}</div></div>
      <div class="card">${W.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Label</th><th>Address</th><th>Network</th><th>Alerts on</th><th>24 h</th><th>Last activity</th><th>Status</th></tr></thead><tbody>
        ${W.map(w => `<tr class="click" data-id="${w.id}"><td class="strong">${esc(w.label)}</td><td class="mono">${esc(short(w.address))}</td><td>${w.network === 'mainnet-beta' ? 'mainnet' : 'devnet'}</td><td style="max-width:280px">${esc(rulesText(w.rules))}</td>
          <td class="num">${w.events24h} tx · ${w.alerts24h} alert${w.alerts24h === 1 ? '' : 's'}</td><td>${ago(w.lastActivityAt)}</td>
          <td>${w.paused ? '<span class="pill mute">Paused</span>' : w.lastError ? `<span class="pill hold" title="${esc(w.lastError)}">Retrying</span>` : '<span class="pill ok">Watching</span>'}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="empty"><b>No wallets yet</b>Add a treasury, an agent wallet, a counterparty or any address you want to keep an eye on.${admin() ? '<br><button class="btn btn-primary btn-xs" id="nw3">Watch a wallet</button>' : ''}</div>`}</div>
      <div class="note">Wallets are checked about every minute while Intercept is in use, and continuously when a cron calls <span class="code-tag">POST /v1/internal/tick</span>. ${W.length}/50 wallets.</div>`;
    ['#nw2', '#nw3'].forEach(sel => { const b = el.querySelector(sel); b && b.addEventListener('click', () => walletForm(null, policies, w => { location.hash = '#/wallets/' + w.id; })); });
    el.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => { location.hash = '#/wallets/' + tr.dataset.id; }));
  };
  async function walletDetail(el, id) {
    const [W, policies] = await Promise.all([get('/wallets'), get('/policies')]);
    const w = W.find(x => x.id === id);
    if (!w) { el.innerHTML = '<div class="card"><div class="empty">Wallet not found.</div></div>'; return; }
    crumb(['wallets', w.label]);
    const E = await get(`/wallets/${w.id}/events`);
    const explorer = s => w.network === 'mainnet-beta' ? `https://solscan.io/tx/${s}` : `https://solscan.io/tx/${s}?cluster=devnet`;
    const flow = list => (list || []).map(f => `${f.amount != null ? Number(f.amount).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '?'} ${f.asset === 'SOL' ? 'SOL' : short(f.asset)}`).join(' + ');
    el.innerHTML = `
      <div class="ph"><div><h1>${esc(w.label)} ${w.paused ? '<span class="pill mute">Paused</span>' : '<span class="pill ok">Watching</span>'}</h1><p class="mono">${esc(w.address)} · ${w.network === 'mainnet-beta' ? 'mainnet' : 'devnet'}</p></div>
        <div class="ph-act"><button class="btn btn-ghost btn-xs" id="wrf">Check now</button>${admin() ? `<button class="btn btn-ghost btn-xs" id="wed">Alert rules</button><button class="btn btn-ghost btn-xs" id="wps">${w.paused ? 'Resume' : 'Pause'}</button><button class="btn btn-danger btn-xs" id="wdl">Stop watching</button>` : ''}</div></div>
      ${w.lastError ? `<div class="note">Last check failed: ${esc(w.lastError)}. It is retried automatically.</div>` : ''}
      <div class="grid4">
        <div class="card stat"><span>Alerts on</span><small style="font-size:13px;color:var(--fg)">${esc(rulesText(w.rules))}</small></div>
        <div class="card stat"><span>Transactions · 24 h</span><b>${w.events24h}</b></div>
        <div class="card stat"><span>Alerts · 24 h</span><b>${w.alerts24h}</b></div>
        <div class="card stat"><span>Last checked</span><small style="font-size:13px;color:var(--fg)">${ago(w.lastCheckedAt)}</small></div>
      </div>
      <div class="card"><div class="card-h"><h2>Transactions</h2><span class="lnk">${E.length}</span></div>
        ${E.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Direction</th><th>Moved</th><th>Value</th><th>Policy</th><th>What</th><th></th></tr></thead><tbody>
          ${E.map(e => { const [c, t] = DIR[e.direction]; const s = e.summary || {}; return `<tr><td>${ago(e.block_time || e.created_at)}</td><td><span class="pill ${c}">${t}</span>${e.alerted ? ' <span class="pill hold">alert</span>' : ''}</td>
            <td class="mono" style="max-width:220px">${esc(e.direction === 'INCOMING' ? flow(s.in) : flow(s.out)) || '—'}</td><td class="num">${usd(e.direction === 'INCOMING' ? e.value_in_usd : e.value_out_usd)}</td>
            <td>${e.decision ? pill({ decision: e.decision }) : '<span class="muted">not signed by it</span>'}${(e.reasons || []).slice(0, 2).map(r => ` <span class="code-tag">${esc(r)}</span>`).join('')}</td>
            <td style="max-width:240px"><small>${esc((s.kinds || []).join(' · ').toLowerCase().replace(/_/g, ' '))}</small><br><small class="muted">${esc((s.programs || []).join(', '))}</small>${s.failed ? ' <span class="pill bad">failed</span>' : ''}</td>
            <td><a href="${explorer(e.signature)}" target="_blank" rel="noopener" class="mono">${esc(e.signature.slice(0, 6))}… ↗</a></td></tr>`; }).join('')}
        </tbody></table></div>` : '<div class="empty">No transaction recorded yet.</div>'}</div>`;
    el.querySelector('#wrf').addEventListener('click', async e => {
      e.target.disabled = true; e.target.textContent = 'Checking…';
      try { const r = await post(`/wallets/${w.id}/refresh`); toast(r.newEvents ? `${r.newEvents} new transaction(s).` : 'No new transaction.'); render(); } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Check now'; }
    });
    const ed = el.querySelector('#wed'); ed && ed.addEventListener('click', () => walletForm(w, policies, () => render()));
    const ps = el.querySelector('#wps'); ps && ps.addEventListener('click', async () => { await api('PATCH', o('/wallets/' + w.id), { paused: !w.paused }); render(); });
    const dl = el.querySelector('#wdl'); dl && dl.addEventListener('click', async () => {
      if (!(await confirmBox('Stop watching ' + w.label + '?', 'Its recorded transactions are deleted. Past alerts stay in Alerts.', 'Stop watching', true))) return;
      await api('DELETE', o('/wallets/' + w.id)); toast('Stopped watching.'); location.hash = '#/wallets';
    });
  }

  /* ---------------- alerts ---------------- */
  VIEWS.alerts = async el => {
    crumb(['alerts']);
    const A = await get('/alerts');
    const sev = { LOW: 'mute', MEDIUM: 'hold', HIGH: 'bad', CRITICAL: 'bad' };
    el.innerHTML = `<div class="ph"><div><h1>Alerts</h1><p>Raised on critical denials and on transactions waiting for approval. Subscribe a webhook to <span class="code-tag">alert.created</span> to receive them.</p></div></div>
      <div class="card">${A.length ? `<div class="rows">${A.map(a => `<div class="row"><span class="pill ${sev[a.severity]}">${a.severity.toLowerCase()}</span><div class="grow"><b>${esc(a.message)}</b><small><span class="code-tag">${esc(a.type)}</span> · ${ago(a.created_at)}${a.acknowledged_at ? ' · acknowledged' : ''}</small></div>
        ${a.evaluation_id ? `<a class="btn btn-ghost btn-xs" href="#/activity/${a.evaluation_id}">Open</a>` : ''}${a.watched_wallet_id ? `<a class="btn btn-ghost btn-xs" href="#/wallets/${a.watched_wallet_id}">Wallet</a>` : ''}${a.signature ? `<a class="btn btn-ghost btn-xs" href="https://solscan.io/tx/${a.signature}" target="_blank" rel="noopener">Tx ↗</a>` : ''}${!a.acknowledged_at && admin() ? `<button class="btn btn-ghost btn-xs" data-ack="${a.id}">Acknowledge</button>` : ''}</div>`).join('')}</div>` : '<div class="empty"><b>No alerts</b>Nothing critical has happened.</div>'}</div>`;
    el.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', async () => { await post(`/alerts/${b.dataset.ack}/ack`); render(); }));
  };

  /* ---------------- agents ---------------- */
  const STATUS = { ACTIVE: ['ok', 'Active'], PAUSED: ['hold', 'Paused'], REVOKED: ['mute', 'Revoked'] };
  const st = a => `<span class="pill ${STATUS[a.status][0]}">${STATUS[a.status][1]}</span>`;
  async function agentForm(a) {
    const policies = await get('/policies');
    modal(a ? 'Edit agent' : 'Register an agent', `
      <form class="form" id="af">
        <label class="fld full"><span>Name</span><input name="name" maxlength="64" value="${esc(a && a.name)}" placeholder="treasury-rebalancer" required></label>
        <label class="fld full"><span>Description</span><input name="description" maxlength="500" value="${esc(a && a.description)}" placeholder="What this agent does"></label>
        <label class="fld full"><span>Wallet <small>the address the agent signs with</small></span><input name="wallet" maxlength="44" value="${esc(a && a.wallet)}" class="mono" placeholder="Base58 address"></label>
        ${a ? '' : `<label class="fld"><span>Network</span><select name="network"><option value="devnet">Devnet (test keys)</option><option value="mainnet-beta">Mainnet (live keys)</option></select></label>`}
        <label class="fld${a ? ' full' : ''}"><span>Policy</span><select name="policyId">${a ? '' : '<option value="">New policy with safe defaults</option>'}${policies.map(p => `<option value="${p.id}"${a && a.policy.id === p.id ? ' selected' : ''}>${esc(p.name)} · v${p.currentVersion}</option>`).join('')}</select></label>
        <p class="err full" id="af-err"></p>
        <div class="form-act full"><button type="button" class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn btn-primary btn-xs" type="submit">${a ? 'Save' : 'Register agent'}</button></div>
      </form>`, (box, close) => box.querySelector('#af').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const body = { name: fd.name, description: fd.description, wallet: fd.wallet ? fd.wallet.trim() : null };
      if (fd.policyId) body.policyId = fd.policyId;
      if (!a) body.network = fd.network;
      try {
        const r = a ? await api('PATCH', o('/agents/' + a.id), body) : await post('/agents', body);
        toast(a ? 'Agent saved.' : 'Agent registered.'); close(); location.hash = '#/agents/' + r.id; render();
      } catch (err) { box.querySelector('#af-err').textContent = issues(err); }
    }));
  }
  VIEWS.agents = async (el, id) => {
    if (id) return agentDetail(el, id);
    crumb(['agents']);
    const agents = await get('/agents');
    el.innerHTML = `${stopBanner()}
      <div class="ph"><div><h1>Agents</h1><p>Each agent signs with one wallet, runs on one network and is evaluated against one pinned policy version.</p></div>
        <div class="ph-act">${admin() ? '<button class="btn btn-primary btn-xs" id="new-agent">Register agent</button>' : ''}</div></div>
      <div class="card">${agents.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Wallet</th><th>Network</th><th>Mode</th><th>Policy</th><th>Status</th><th>Last activity</th></tr></thead><tbody>
        ${agents.map(a => `<tr class="click" data-id="${a.id}"><td class="strong">${esc(a.name)}</td><td class="mono">${a.wallet ? esc(short(a.wallet)) + (a.walletVerified ? ' ✓' : '') : '<span class="muted">—</span>'}</td><td>${a.network}</td><td>${a.integrationMode === 'ENFORCED_EXECUTION' ? '<span class="pill ok">Enforced</span>' : '<span class="pill mute">Evaluation</span>'}</td><td class="num">v${a.policy.version}</td><td>${st(a)}</td><td>${ago(a.lastActivityAt)}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="empty"><b>No agents yet</b>Register the agents you want Intercept to control.${admin() ? '<br><button class="btn btn-primary btn-xs" id="new-agent-2">Register agent</button>' : ''}</div>`}</div>`;
    ['#new-agent', '#new-agent-2'].forEach(s => { const b = el.querySelector(s); b && b.addEventListener('click', () => agentForm()); });
    el.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => { location.hash = '#/agents/' + tr.dataset.id; }));
  };
  async function agentDetail(el, id) {
    const [a, keys, recent] = await Promise.all([get('/agents/' + id), get('/keys'), get('/evaluations?limit=10&agentId=' + id)]);
    crumb(['agents', a.name]);
    const myKeys = keys.filter(k => k.agentId === a.id);
    el.innerHTML = `${stopBanner()}
      <div class="ph"><div><h1>${esc(a.name)} ${st(a)}</h1><p>${esc(a.description) || 'No description.'}</p></div>
        <div class="ph-act">${admin() && a.status !== 'REVOKED' ? `<button class="btn btn-ghost btn-xs" id="ag-edit">Edit</button>${a.status === 'ACTIVE' ? '<button class="btn btn-ghost btn-xs" data-act="pause">Pause</button>' : '<button class="btn btn-ghost btn-xs" data-act="resume">Resume</button>'}<button class="btn btn-danger btn-xs" data-act="revoke">Revoke</button>` : ''}</div></div>
      <div class="grid2">
        <div class="card"><div class="card-h"><h2>Configuration</h2></div><div class="kv">
          <div>Agent ID</div><div class="mono">${a.id}</div>
          <div>Network</div><div>${a.network} · ${a.network === 'mainnet-beta' ? 'live keys (icpt_live_)' : 'test keys (icpt_test_)'}</div>
          <div>Wallet</div><div class="mono">${a.wallet ? esc(a.wallet) : '—'}</div>
          <div>Ownership</div><div>${a.walletVerified ? `<span class="pill ok">Verified</span> ${ago(a.walletVerifiedAt)}` : a.wallet ? `<span class="pill hold">Not verified</span>${admin() ? ' <button class="btn btn-ghost btn-xs" id="ag-verify">Verify</button>' : ''}` : 'Set a wallet first'}</div>
          <div>Policy</div><div><a href="#/policies/${a.policy.id}">${esc(a.policy.id)}</a> · pinned to v${a.policy.version}</div>
          <div>Created</div><div>${new Date(a.createdAt).toLocaleString()}</div>
        </div></div>
        <div class="card"><div class="card-h"><h2>Integration mode</h2></div><div class="card-b">
          <div class="seg" id="mode"><button type="button" data-m="EVALUATION" aria-pressed="${a.integrationMode === 'EVALUATION'}">Evaluation</button><button type="button" data-m="ENFORCED_EXECUTION" aria-pressed="${a.integrationMode === 'ENFORCED_EXECUTION'}">Enforced execution</button></div>
          <p class="muted" style="margin-top:12px;font-size:13px">${a.integrationMode === 'ENFORCED_EXECUTION'
            ? 'The agent requests <span class="code-tag">POST /v1/execution/requests</span>. An allowed transaction returns an Ed25519-signed authorization bound to its message hash; your signer verifies it with the published key and consumes it once before signing. Without that check in the signer, nothing is enforced.'
            : 'The agent calls <span class="code-tag">POST /v1/transactions/evaluate</span> and is trusted to respect the decision. Switch to enforced execution once its wallet is verified and its signer checks authorizations.'}</p>
        </div></div>
      </div>
      <div class="card"><div class="card-h"><h2>API keys</h2><a href="#/keys">Manage keys</a></div>
        ${myKeys.length ? `<div class="rows">${myKeys.map(k => `<div class="row"><span class="mono">${esc(k.prefix)}…</span><div class="grow"><b>${esc(k.name)}</b><small>${k.scopes.join(', ')}</small></div>${k.revokedAt ? '<span class="pill mute">Revoked</span>' : '<span class="pill ok">Active</span>'}</div>`).join('')}</div>` : '<div class="empty">No key for this agent yet.</div>'}</div>
      <div class="card"><div class="card-h"><h2>Recent evaluations</h2><a href="#/activity">All activity</a></div>
        ${recent.length ? `<div class="rows">${recent.map(e => `<a class="row" href="#/activity/${e.id}"><div class="grow"><b>${usd(e.valueUsd)}</b><small>${e.reasons.slice(0, 2).map(r => r.code).join(', ') || 'no rule triggered'} · ${ago(e.createdAt)}</small></div>${pill(e)}</a>`).join('')}</div>` : '<div class="empty">No evaluation yet.</div>'}</div>`;
    const edit = el.querySelector('#ag-edit'); edit && edit.addEventListener('click', () => agentForm(a));
    el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'revoke' && !(await confirmBox('Revoke ' + a.name + '?', 'This is permanent. Every API key of the agent is revoked and all its transactions are denied.', 'Revoke agent', true))) return;
      try { await post(`/agents/${a.id}/${act}`); toast(act === 'pause' ? 'Agent paused: its transactions are now denied.' : act === 'resume' ? 'Agent resumed.' : 'Agent revoked.'); render(); } catch (e) { toast(e.message, true); }
    }));
    el.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', async () => {
      if (!admin() || b.getAttribute('aria-pressed') === 'true') return;
      try { await api('PATCH', o('/agents/' + a.id), { integrationMode: b.dataset.m }); toast('Mode updated.'); render(); } catch (e) { toast(e.message, true); }
    }));
    const v = el.querySelector('#ag-verify'); v && v.addEventListener('click', () => verifyWallet(a));
  }
  async function verifyWallet(a) {
    const ch = await post(`/agents/${a.id}/wallet-challenge`);
    const snippet = `// Node.js, with the agent keypair (never send the secret key anywhere)\nconst nacl = require('tweetnacl'); const bs58 = require('bs58');\nconst msg = new TextEncoder().encode(${JSON.stringify(ch.message)});\nconsole.log(bs58.encode(nacl.sign.detached(msg, keypair.secretKey)));`;
    const provider = window.phantom && window.phantom.solana || window.solflare || window.solana;
    modal('Verify wallet ownership', `
      <p class="muted">The agent wallet <span class="mono">${esc(short(a.wallet))}</span> signs this one-time message. The signature proves control and cannot move funds.</p>
      <pre class="snip">${esc(ch.message)}</pre>
      ${provider ? '<div class="form-act" style="justify-content:flex-start"><button class="btn btn-primary btn-xs" id="vw-browser">Sign with the browser wallet</button></div>' : ''}
      <p class="muted" style="margin-top:12px">Or sign it where the agent key lives and paste the base58 signature:</p>
      <pre class="snip">${esc(snippet)}</pre>
      <form class="form" id="vw"><label class="fld full"><span>Signature</span><input name="signature" class="mono" placeholder="Base58 signature"></label><p class="err full" id="vw-err"></p>
      <div class="form-act full"><button type="button" class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn btn-primary btn-xs">Verify</button></div></form>`,
    (box, close) => {
      const send = async sig => {
        try { await post(`/agents/${a.id}/wallet-verify`, { challengeId: ch.challengeId, signature: sig }); toast('Wallet verified.'); close(); render(); }
        catch (e) { box.querySelector('#vw-err').textContent = e.message; }
      };
      box.querySelector('#vw').addEventListener('submit', e => { e.preventDefault(); send(new FormData(e.target).get('signature').trim()); });
      const b = box.querySelector('#vw-browser');
      b && b.addEventListener('click', async () => {
        try {
          const r = await provider.connect();
          const pk = (r && r.publicKey ? r.publicKey : provider.publicKey).toString();
          if (pk !== a.wallet) { box.querySelector('#vw-err').textContent = `The connected wallet (${short(pk)}) is not the agent wallet.`; return; }
          const s = await provider.signMessage(new TextEncoder().encode(ch.message), 'utf8');
          const bytes = s.signature || s;
          send(btoa(String.fromCharCode(...bytes)));
        } catch (e) { box.querySelector('#vw-err').textContent = e.message || 'Signing was cancelled.'; }
      });
    }, true);
  }

  /* ---------------- policies ---------------- */
  VIEWS.policies = async (el, id) => {
    if (id) return policyEditor(el, id === 'new' ? null : id);
    crumb(['policies']);
    const P = await get('/policies');
    const r = p => p.config.risk, x = p => p.config.execution;
    el.innerHTML = `
      <div class="ph"><div><h1>Policies</h1><p>Evaluated server-side for every transaction. Each change creates an immutable version, and every evaluation records the version it used.</p></div>
        <div class="ph-act">${admin() ? '<a class="btn btn-primary btn-xs" href="#/policies/new">New policy</a>' : ''}</div></div>
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Version</th><th>Max tx</th><th>Daily spend</th><th>Approval above</th><th>Max slippage</th><th>Fail closed</th><th>Agents</th><th>Updated</th></tr></thead><tbody>
      ${P.map(p => `<tr class="click" data-id="${p.id}"><td class="strong">${esc(p.name)}</td><td class="num">v${p.currentVersion}</td><td class="num">${usd(r(p).maxTransactionValueUsd)}</td><td class="num">${usd(r(p).maxDailySpendUsd)}</td><td class="num">${usd(x(p).requireApprovalAboveUsd)}</td><td class="num">${r(p).maxSlippageBps != null ? r(p).maxSlippageBps + ' bps' : '—'}</td><td>${x(p).failClosed ? 'yes' : 'no'}</td><td class="num">${p.agents}</td><td>${ago(p.updatedAt)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    el.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => { location.hash = '#/policies/' + tr.dataset.id; }));
  };
  const FIELDS = [
    ['risk', 'maxTransactionValueUsd', 'Max transaction value', 'USD', 'usd', 'RISK_MAX_TX_VALUE · outflow from the agent wallet, priced at fresh market prices'],
    ['risk', 'maxDailySpendUsd', 'Max daily spending', 'USD', 'usd', 'RISK_DAILY_SPEND · rolling 24 h of allowed and approved transactions'],
    ['execution', 'requireApprovalAboveUsd', 'Require approval above', 'USD', 'usd', 'RISK_APPROVAL_THRESHOLD'],
    ['risk', 'maxPositionSizeUsd', 'Max position size', 'USD', 'usd', 'RISK_POSITION_SIZE · holding per asset after the transaction'],
    ['risk', 'maxPortfolioExposureUsd', 'Max portfolio exposure', 'USD', 'usd', 'Non-stablecoin holdings after the transaction'],
    ['risk', 'maxAssetConcentrationBps', 'Max asset concentration', 'bps', 'int', '10000 bps = 100% of the wallet'],
    ['risk', 'maxSlippageBps', 'Max slippage', 'bps', 'int', 'Read from the swap instruction (Jupiter v6)'],
    ['risk', 'minLiquidityUsd', 'Min liquidity of received tokens', 'USD', 'usd', 'From the price source'],
    ['risk', 'maxLeverage', 'Max leverage', 'x', 'dec', 'Spot programs = 1x; other programs: no adapter yet (unsupported)'],
    ['risk', 'maxDailyLossBps', 'Max daily loss', 'bps', 'int', 'Not enforceable yet: reported UNSUPPORTED'],
    ['risk', 'maxDrawdownBps', 'Max drawdown', 'bps', 'int', 'Not enforceable yet: reported UNSUPPORTED'],
  ];
  const LISTS = [['allowedPrograms', 'Allowed programs', 'Empty = any program not blocked. System, Token, Token-2022, ATA, Memo, Compute Budget are always allowed (their effects are checked).'], ['blockedPrograms', 'Blocked programs', 'Also applies to programs called inside the transaction'],
    ['allowedRecipients', 'Allowed recipients', 'Wallets the agent may send to (token recipients are resolved to their owner)'], ['blockedRecipients', 'Blocked recipients', ''], ['allowedMints', 'Allowed token mints', 'Empty = any token'], ['restrictedMints', 'Restricted token mints', '']];
  async function policyEditor(el, id) {
    const [p, def] = await Promise.all([id ? get('/policies/' + id) : null, api('GET', '/policy-schema/default')]);
    const cfg = JSON.parse(JSON.stringify(p ? p.versions[0].config : def));
    crumb(['policies', p ? p.name : 'New policy']);
    const ro = admin() ? '' : ' disabled';
    const fld = ([sec, k, label, unit, kind, hint]) => `<label class="fld"><span>${label} <small>${unit}</small></span><input data-sec="${sec}" data-k="${k}" data-kind="${kind}" value="${cfg[sec][k] == null ? '' : esc(cfg[sec][k])}" placeholder="no limit" inputmode="decimal"${ro}><small>${hint}</small></label>`;
    el.innerHTML = `
      <div class="ph"><div><h1>${p ? esc(p.name) : 'New policy'}</h1><p>${p ? `Version ${p.currentVersion}. Saving creates version ${p.currentVersion + 1} and moves the agents using this policy to it.` : 'Start from safe defaults, then assign the policy to an agent.'}</p></div>
        <div class="ph-act">${p && admin() ? '<button class="btn btn-danger btn-xs" id="pdel">Archive</button>' : ''}${admin() ? '<button class="btn btn-primary btn-xs" id="psave">Save new version</button>' : ''}</div></div>
      <div class="eval-grid">
        <div class="card"><div class="card-b form">
          <label class="fld full"><span>Name</span><input id="pname" maxlength="64" value="${esc(p ? p.name : '')}" placeholder="Conservative trading"${ro}></label>
          <p class="full sect">FINANCIAL RISK <small>Empty = no limit. Decimal strings, never floats.</small></p>
          ${FIELDS.map(fld).join('')}
          <p class="full sect">SECURITY</p>
          ${LISTS.map(([k, label, hint]) => `<label class="fld full"><span>${label}</span><textarea data-list="${k}" rows="2" class="mono" placeholder="One address per line"${ro}>${esc(cfg.security[k].join('\n'))}</textarea>${hint ? `<small>${hint}</small>` : ''}</label>`).join('')}
          ${[['blockUnknownRecipients', 'Block transfers to recipients that are not allowlisted'], ['allowDelegateApprovals', 'Allow token delegate approvals'], ['allowAuthorityChanges', 'Allow authority and owner changes'], ['requireSimulation', 'Require a successful simulation']].map(([k, t]) => `<label class="chk2 full"><input type="checkbox" data-bool="security.${k}"${cfg.security[k] ? ' checked' : ''}${ro}>${t}</label>`).join('')}
          <label class="fld"><span>Unknown instructions</span><select data-sel="security.unknownInstructions"${ro}>${['DENY', 'REQUIRE_APPROVAL', 'ALLOW'].map(v => `<option${cfg.security.unknownInstructions === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
          <p class="full sect">EXECUTION</p>
          <label class="chk2 full"><input type="checkbox" data-bool="execution.failClosed"${cfg.execution.failClosed ? ' checked' : ''}${ro}>Fail closed: deny when data is missing (otherwise ask a human). Missing data never allows.</label>
          <label class="fld"><span>Unsupported checks</span><select data-sel="execution.unsupportedChecks"${ro}>${['REQUIRE_APPROVAL', 'DENY', 'WARN'].map(v => `<option${cfg.execution.unsupportedChecks === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="fld"><span>Approval window <small>seconds</small></span><input data-sec="execution" data-k="approvalTtlSecs" data-kind="int" value="${cfg.execution.approvalTtlSecs}"${ro}></label>
          <label class="fld"><span>Authorization lifetime <small>seconds</small></span><input data-sec="execution" data-k="authorizationTtlSecs" data-kind="int" value="${cfg.execution.authorizationTtlSecs}"${ro}></label>
          <p class="err full" id="perr"></p>
        </div></div>
        <div>
          <div class="card" style="position:sticky;top:0"><div class="card-h"><h2>policy.json</h2><button class="btn btn-ghost btn-xs" id="pcopy">Copy</button></div><pre class="snip" id="pjson" style="border-top:0;max-height:420px"></pre></div>
          ${p ? `<div class="card"><div class="card-h"><h2>Versions</h2></div><div class="rows">${p.versions.map(v => `<div class="row"><b class="num">v${v.version}</b><div class="grow"><small>${new Date(v.created_at).toLocaleString()} · ${v.config_hash.slice(0, 12)}</small></div></div>`).join('')}</div></div>` : ''}
        </div>
      </div>`;
    const read = () => {
      el.querySelectorAll('[data-k]').forEach(i => {
        const v = i.value.trim();
        cfg[i.dataset.sec][i.dataset.k] = v === '' ? (i.dataset.sec === 'execution' && i.dataset.k.endsWith('Secs') ? def.execution[i.dataset.k] : null) : (i.dataset.kind === 'int' ? Number(v) : v);
      });
      el.querySelectorAll('[data-list]').forEach(i => { cfg.security[i.dataset.list] = i.value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean); });
      el.querySelectorAll('[data-bool]').forEach(i => { const [a, b] = i.dataset.bool.split('.'); cfg[a][b] = i.checked; });
      el.querySelectorAll('[data-sel]').forEach(i => { const [a, b] = i.dataset.sel.split('.'); cfg[a][b] = i.value; });
      el.querySelector('#pjson').textContent = JSON.stringify(cfg, null, 2);
    };
    el.addEventListener('input', read); el.addEventListener('change', read); read();
    el.querySelector('#pcopy').addEventListener('click', () => copy(el.querySelector('#pjson').textContent));
    const save = el.querySelector('#psave');
    save && save.addEventListener('click', async () => {
      read(); save.disabled = true; el.querySelector('#perr').textContent = '';
      const name = el.querySelector('#pname').value.trim();
      try {
        if (p) { const r = await post(`/policies/${p.id}/versions`, { config: cfg, name: name || undefined }); toast(`Saved as v${r.version}; ${r.agentsUpdated} agent(s) moved to it.`); render(); }
        else { const r = await post('/policies', { name: name || 'Untitled policy', config: cfg }); toast('Policy created.'); location.hash = '#/policies/' + r.id; }
      } catch (err) { el.querySelector('#perr').textContent = issues(err); } finally { save.disabled = false; }
    });
    const del = el.querySelector('#pdel');
    del && del.addEventListener('click', async () => { try { await api('DELETE', o('/policies/' + p.id)); toast('Policy archived.'); location.hash = '#/policies'; } catch (err) { toast(err.message, true); } });
  }

  /* ---------------- evaluate ---------------- */
  VIEWS.evaluate = async el => {
    crumb(['evaluate']);
    const agents = (await get('/agents')).filter(a => a.status !== 'REVOKED');
    if (!agents.length) { el.innerHTML = `<div class="ph"><div><h1>Evaluate</h1></div></div><div class="card"><div class="empty"><b>Register an agent first</b>Evaluations run against an agent's wallet, network and policy.<br><a class="btn btn-primary btn-xs" href="#/agents">Register agent</a></div></div>`; return; }
    const st = VIEWS.evaluate.st || (VIEWS.evaluate.st = { agentId: agents[0].id, tx: '' });
    if (!agents.some(a => a.id === st.agentId)) st.agentId = agents[0].id;
    const build = `// build a transaction without signing it, then send its base64 to Intercept\nconst { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');\nconst conn = new Connection('https://api.devnet.solana.com');\nconst payer = new PublicKey('<agent wallet>');\nconst msg = new TransactionMessage({\n  payerKey: payer,\n  recentBlockhash: (await conn.getLatestBlockhash()).blockhash,\n  instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey('<recipient>'), lamports: 10_000_000 })],\n}).compileToV0Message();\nconsole.log(Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'));`;
    el.innerHTML = `
      <div class="ph"><div><h1>Evaluate</h1><p>Paste a serialized transaction (legacy or v0, base64, signatures may be empty). Intercept decodes the bytes, resolves lookup tables, simulates it on the agent's network, prices the movements and applies the agent's policy. Nothing is signed or sent.</p></div></div>
      ${viewerNote()}
      <div class="eval-grid">
        <div class="card"><form class="card-b form" id="ef">
          <label class="fld full"><span>Agent</span><select name="agentId">${agents.map(a => `<option value="${a.id}"${a.id === st.agentId ? ' selected' : ''}>${esc(a.name)} · ${a.network}${a.status === 'PAUSED' ? ' (paused)' : ''}</option>`).join('')}</select></label>
          <label class="fld full"><span>Transaction <small>base64</small></span><textarea name="tx" rows="7" class="mono" placeholder="AQAAAAAAAAAAAAAAAAAAAAAA…">${esc(st.tx)}</textarea></label>
          <div class="form-act full"><button class="btn btn-primary btn-xs" type="submit" id="ego"${admin() ? '' : ' disabled'}>Evaluate</button></div>
          <details class="full"><summary class="muted">How to produce a transaction</summary><pre class="snip">${esc(build)}</pre></details>
        </form></div>
        <div class="card" id="eres"><div class="card-h"><h2>Decision</h2></div><div class="empty">Submit a transaction to see the decision.</div></div>
      </div>`;
    const f = el.querySelector('#ef');
    f.addEventListener('submit', async e => {
      e.preventDefault();
      st.agentId = f.elements.agentId.value; st.tx = f.elements.tx.value.trim();
      const btn = el.querySelector('#ego'); btn.disabled = true; btn.textContent = 'Decoding and simulating…';
      try {
        const d = await post(`/agents/${st.agentId}/evaluate`, { transaction: st.tx });
        const [c, t] = DEC[d.decision];
        const curl = `curl -X POST ${API}/v1/transactions/evaluate \\\n  -H "Authorization: Bearer $INTERCEPT_API_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"transaction":"<base64>"}'`;
        el.querySelector('#eres').innerHTML = `
          <div class="card-h"><h2>Decision</h2><a href="#/activity/${d.id}">Full detail</a></div>
          <div class="verdict2"><span class="big ${c}">${t.toUpperCase()}</span><span class="muted" style="font-size:12.5px">${usd(d.valueUsd)} · policy v${d.policy.version} · ${d.latencyMs} ms${d.decision === 'REQUIRE_APPROVAL' ? ' · <a href="#/approvals" style="color:var(--hold)">waiting in Approvals</a>' : ''}</span></div>
          ${d.reasons.length ? `<div class="rows">${d.reasons.map(r => `<div class="row"><span class="code-tag">${esc(r.code)}</span><div class="grow"><small>${esc(r.message)}</small></div></div>`).join('')}</div>` : '<div class="note">No rule was triggered.</div>'}
          ${checksTable([...d.checks.security, ...d.checks.risk].filter(x => x.status !== 'NOT_CONFIGURED' && x.status !== 'NOT_APPLICABLE'))}
          <div class="copyrow"><span>From your agent, with its API key</span><button class="btn btn-ghost btn-xs" id="ccurl">Copy</button></div><pre class="snip">${esc(curl)}</pre>`;
        el.querySelector('#ccurl').addEventListener('click', () => copy(curl));
        refreshPending().then(nav);
      } catch (err) { toast(issues(err), true); }
      finally { btn.disabled = false; btn.textContent = 'Evaluate'; }
    });
  };

  /* ---------------- api keys ---------------- */
  const SCOPES = [['transactions:evaluate', 'Evaluate transactions'], ['transactions:read', 'Read its evaluations'], ['execution:request', 'Request execution authorizations'], ['agent:read', 'Read its agent and policy']];
  VIEWS.keys = async el => {
    crumb(['keys']);
    const [K, agents] = await Promise.all([get('/keys'), get('/agents')]);
    const ex = `curl -X POST ${API}/v1/transactions/evaluate \\\n  -H "Authorization: Bearer icpt_test_…" \\\n  -H "content-type: application/json" \\\n  -d '{"transaction":"<base64 serialized transaction>"}'`;
    el.innerHTML = `
      <div class="ph"><div><h1>API keys</h1><p>Each key belongs to one agent. <span class="code-tag">icpt_test_</span> keys work with devnet agents, <span class="code-tag">icpt_live_</span> keys with mainnet agents. A key can never change policies, keys or agents. The full key is shown once; Intercept stores only a keyed digest.</p></div>
        <div class="ph-act">${admin() ? '<button class="btn btn-primary btn-xs" id="nk">Create key</button>' : ''}</div></div>
      <div class="card">${K.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Agent</th><th>Key</th><th>Scopes</th><th>Rate</th><th>Expires</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>
        ${K.map(k => `<tr><td class="strong">${esc(k.name)}</td><td>${esc(agentName(agents, k.agentId))}</td><td class="mono">${esc(k.prefix)}…</td><td>${k.scopes.map(s => `<span class="code-tag">${s}</span>`).join(' ')}</td><td class="num">${k.rateLimitPerMin}/min</td><td>${k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'never'}</td><td>${ago(k.lastUsedAt)}</td><td>${k.revokedAt ? '<span class="pill mute">Revoked</span>' : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? '<span class="pill mute">Expired</span>' : '<span class="pill ok">Active</span>'}</td>
          <td style="text-align:right;white-space:nowrap">${!k.revokedAt && admin() ? `<button class="btn btn-ghost btn-xs" data-rot="${k.id}">Rotate</button> <button class="btn btn-danger btn-xs" data-rv="${k.id}">Revoke</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty"><b>No keys yet</b>Create a key for an agent to call the API.</div>'}</div>
      <div class="card"><div class="card-h"><h2>Request</h2><button class="btn btn-ghost btn-xs" id="cex">Copy</button></div><pre class="snip" style="border-top:0">${esc(ex)}</pre>
        <div class="note">The response carries <span class="code-tag">decision</span> (ALLOW, DENY or REQUIRE_APPROVAL), the reasons with their codes, every check, the decoded instructions and the simulation. Spec: <a href="${API}/v1/openapi.json" target="_blank" rel="noopener">openapi.json</a>.</div></div>`;
    el.querySelector('#cex').addEventListener('click', () => copy(ex));
    const nk = el.querySelector('#nk');
    nk && nk.addEventListener('click', () => {
      const usable = agents.filter(a => a.status !== 'REVOKED');
      if (!usable.length) return toast('Register an agent first.', true);
      modal('Create API key', `<form class="form" id="kf">
        <label class="fld full"><span>Agent</span><select name="agentId">${usable.map(a => `<option value="${a.id}">${esc(a.name)} · ${a.network === 'mainnet-beta' ? 'live' : 'test'}</option>`).join('')}</select></label>
        <label class="fld full"><span>Name</span><input name="name" maxlength="64" placeholder="production" required></label>
        <div class="fld full"><span>Scopes</span>${SCOPES.map(([s, t], i) => `<label class="chk2"><input type="checkbox" name="scope" value="${s}"${i !== 2 ? ' checked' : ''}>${t} <span class="code-tag">${s}</span></label>`).join('')}</div>
        <label class="fld"><span>Rate limit <small>requests / minute</small></span><input name="rate" type="number" min="1" max="600" value="60"></label>
        <label class="fld"><span>Expires <small>optional</small></span><input name="exp" type="date"></label>
        <p class="err full" id="kerr"></p>
        <div class="form-act full"><button type="button" class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn btn-primary btn-xs">Create key</button></div></form>`,
      (box, close) => box.querySelector('#kf').addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const exp = fd.get('exp');
        try {
          const k = await post('/keys', { agentId: fd.get('agentId'), name: fd.get('name'), scopes: fd.getAll('scope'), rateLimitPerMin: Number(fd.get('rate')), expiresAt: exp ? new Date(exp + 'T23:59:59Z').toISOString() : null });
          close(); render();
          secretModal('Copy your key now', 'This is the only time the full key is shown. Store it as a secret in the agent environment (for example INTERCEPT_API_KEY).', k.key);
        } catch (err) { box.querySelector('#kerr').textContent = issues(err); }
      }));
    });
    el.querySelectorAll('[data-rv]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmBox('Revoke this key?', 'Requests with it fail immediately.', 'Revoke', true))) return;
      try { await api('DELETE', o('/keys/' + b.dataset.rv)); toast('Key revoked.'); render(); } catch (e) { toast(e.message, true); }
    }));
    el.querySelectorAll('[data-rot]').forEach(b => b.addEventListener('click', () => modal('Rotate key', `<form class="form" id="rf"><label class="fld full"><span>Keep the old key valid for</span><select name="g"><option value="0">0 · revoke now</option><option value="3600">1 hour</option><option value="86400">24 hours</option><option value="604800">7 days</option></select><small>A new key with the same agent, scopes and limits is created.</small></label>
      <div class="form-act full"><button type="button" class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn btn-primary btn-xs">Rotate</button></div></form>`,
    (box, close) => box.querySelector('#rf').addEventListener('submit', async e => {
      e.preventDefault();
      try { const k = await post(`/keys/${b.dataset.rot}/rotate`, { graceSecs: Number(new FormData(e.target).get('g')) }); close(); render(); secretModal('Copy the new key now', 'The old key stops working at the end of the grace period.', k.key); }
      catch (err) { toast(err.message, true); }
    }))));
  };

  /* ---------------- webhooks ---------------- */
  const EVENTS = ['evaluation.denied', 'evaluation.approval_required', 'evaluation.resolved', 'alert.created', 'agent.status_changed', 'api_key.revoked', 'organization.emergency_stop'];
  VIEWS.webhooks = async el => {
    crumb(['webhooks']);
    if (!admin()) { el.innerHTML = '<div class="ph"><div><h1>Webhooks</h1></div></div><div class="card"><div class="empty">Webhooks are managed by owners and administrators.</div></div>'; return; }
    const W = await get('/webhooks');
    const verify = `// verify Intercept-Signature: t=<unix>,v1=<hex>\nconst [t, v1] = header.split(',').map(p => p.split('=')[1]);\nconst expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(t + '.' + rawBody).digest('hex');\nconst ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Date.now() / 1000 - t < 300;`;
    el.innerHTML = `
      <div class="ph"><div><h1>Webhooks</h1><p>Signed POST requests to your HTTPS endpoint. Failed deliveries are retried with exponential backoff, up to 6 attempts.</p></div>
        <div class="ph-act"><button class="btn btn-primary btn-xs" id="nw">Add endpoint</button></div></div>
      <div class="card">${W.length ? `<div class="rows">${W.map(w => `<div class="row"><div class="grow"><b class="mono">${esc(w.url)}</b><small>${w.events.join(', ')}${w.disabled_at ? ' · disabled' : ''}</small></div>${w.disabled_at ? '' : `<button class="btn btn-ghost btn-xs" data-dl="${w.id}">Deliveries</button><button class="btn btn-ghost btn-xs" data-test="${w.id}">Send test</button><button class="btn btn-danger btn-xs" data-off="${w.id}">Disable</button>`}</div>`).join('')}</div>` : '<div class="empty"><b>No endpoints</b>Add one to receive denials, approvals and alerts.</div>'}</div>
      <div class="card"><div class="card-h"><h2>Verifying signatures</h2></div><pre class="snip" style="border-top:0">${esc(verify)}</pre></div>`;
    el.querySelector('#nw').addEventListener('click', () => modal('Add endpoint', `<form class="form" id="wf"><label class="fld full"><span>URL</span><input name="url" type="url" placeholder="https://example.com/intercept" required></label>
      <div class="fld full"><span>Events</span>${EVENTS.map(ev => `<label class="chk2"><input type="checkbox" name="ev" value="${ev}" checked><span class="code-tag">${ev}</span></label>`).join('')}</div><p class="err full" id="werr"></p>
      <div class="form-act full"><button type="button" class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn btn-primary btn-xs">Add</button></div></form>`,
    (box, close) => box.querySelector('#wf').addEventListener('submit', async e => {
      e.preventDefault(); const fd = new FormData(e.target);
      try { const w = await post('/webhooks', { url: fd.get('url'), events: fd.getAll('ev') }); close(); render(); secretModal('Signing secret', 'Store this secret to verify the Intercept-Signature header. It is shown once.', w.secret); }
      catch (err) { box.querySelector('#werr').textContent = issues(err); }
    })));
    el.querySelectorAll('[data-test]').forEach(b => b.addEventListener('click', async () => { b.disabled = true; try { const r = await post(`/webhooks/${b.dataset.test}/test`); toast(r.status === 'DELIVERED' ? 'Test delivered.' : 'Test not delivered; it will be retried.', r.status !== 'DELIVERED'); } catch (e) { toast(e.message, true); } b.disabled = false; }));
    el.querySelectorAll('[data-off]').forEach(b => b.addEventListener('click', async () => { await api('DELETE', o('/webhooks/' + b.dataset.off)); render(); }));
    el.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', async () => {
      const D = await get(`/webhooks/${b.dataset.dl}/deliveries`);
      modal('Deliveries', D.length ? `<div class="rows">${D.map(d => `<div class="row"><span class="pill ${d.status === 'DELIVERED' ? 'ok' : d.status === 'FAILED' ? 'bad' : 'hold'}">${d.status.toLowerCase()}</span><div class="grow"><b>${esc(d.event)}</b><small>${d.attempts} attempt(s)${d.last_status_code ? ' · HTTP ' + d.last_status_code : ''}${d.last_error ? ' · ' + esc(d.last_error) : ''} · ${ago(d.created_at)}</small></div>${d.status !== 'DELIVERED' ? `<button class="btn btn-ghost btn-xs" data-rd="${d.id}">Redeliver</button>` : ''}</div>`).join('')}</div>` : '<div class="empty">No deliveries yet.</div>',
        box => box.querySelectorAll('[data-rd]').forEach(x => x.addEventListener('click', async () => { const r = await post(`/deliveries/${x.dataset.rd}/redeliver`); toast('Delivery ' + String(r.status).toLowerCase() + '.'); })), true);
    }));
  };

  /* ---------------- members ---------------- */
  VIEWS.members = async el => {
    crumb(['members']);
    const [M, inv] = await Promise.all([get('/members'), admin() ? get('/invitations') : []]);
    el.innerHTML = `
      <div class="ph"><div><h1>Members</h1><p><b>Owners</b> manage everything, including roles and lifting the emergency stop. <b>Admins</b> manage agents, policies, keys, approvals and webhooks. <b>Viewers</b> read. Agents never hold a role: their keys only reach the agent API.</p></div>
        <div class="ph-act">${admin() ? '<button class="btn btn-primary btn-xs" id="ni">Invite</button>' : ''}</div></div>
      <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Member</th><th>Role</th><th>Since</th><th></th></tr></thead><tbody>
        ${M.map(m => `<tr><td class="strong">${esc(m.display)}${m.id === S.session.user.id ? ' <span class="muted">(you)</span>' : ''}</td><td>${owner() ? `<select data-role="${m.id}">${['OWNER', 'ADMIN', 'VIEWER'].map(r => `<option${m.role === r ? ' selected' : ''}>${r}</option>`).join('')}</select>` : m.role}</td><td>${ago(m.created_at)}</td>
          <td style="text-align:right">${owner() && m.id !== S.session.user.id ? `<button class="btn btn-danger btn-xs" data-rm="${m.id}">Remove</button>` : m.id === S.session.user.id ? `<button class="btn btn-ghost btn-xs" data-rm="${m.id}">Leave</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div></div>
      ${admin() && inv.length ? `<div class="card"><div class="card-h"><h2>Invitations</h2></div><div class="rows">${inv.map(i => `<div class="row"><div class="grow"><b>${esc(i.email || 'Link invitation')} · ${i.role}</b><small>${i.accepted_at ? 'accepted ' + ago(i.accepted_at) : i.revoked_at ? 'revoked' : 'expires ' + new Date(i.expires_at).toLocaleDateString()}</small></div>${!i.accepted_at && !i.revoked_at ? `<button class="btn btn-ghost btn-xs" data-ri="${i.id}">Revoke</button>` : ''}</div>`).join('')}</div></div>` : ''}`;
    el.querySelectorAll('[data-role]').forEach(s => s.addEventListener('change', async () => { try { await api('PATCH', o('/members/' + s.dataset.role), { role: s.value }); toast('Role updated.'); } catch (e) { toast(e.message, true); render(); } }));
    el.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
      const self = b.dataset.rm === S.session.user.id;
      if (!(await confirmBox(self ? 'Leave this organization?' : 'Remove this member?', self ? 'You lose access to its agents and data.' : 'They lose access immediately.', self ? 'Leave' : 'Remove', true))) return;
      try { await api('DELETE', o('/members/' + b.dataset.rm)); if (self) return location.reload(); render(); } catch (e) { toast(e.message, true); }
    }));
    el.querySelectorAll('[data-ri]').forEach(b => b.addEventListener('click', async () => { await api('DELETE', o('/invitations/' + b.dataset.ri)); render(); }));
    const ni = el.querySelector('#ni');
    ni && ni.addEventListener('click', () => modal('Invite a member', `<form class="form" id="if"><label class="fld"><span>Role</span><select name="role"><option>VIEWER</option>${owner() ? '<option>ADMIN</option>' : ''}</select></label><label class="fld"><span>Email <small>optional · restricts who can accept</small></span><input name="email" type="email"></label><p class="err full" id="ierr"></p>
      <div class="form-act full"><button type="button" class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn btn-primary btn-xs">Create invitation</button></div></form>`,
    (box, close) => box.querySelector('#if').addEventListener('submit', async e => {
      e.preventDefault(); const fd = new FormData(e.target);
      try { const r = await post('/invitations', { role: fd.get('role'), email: fd.get('email') || undefined }); close(); render(); secretModal('Invitation link', 'Send this link. It works once and expires in 7 days.', r.url); }
      catch (err) { box.querySelector('#ierr').textContent = issues(err); }
    })));
  };
  async function acceptInvite(token) {
    try { const r = await api('POST', '/invitations/accept', { token }); toast('You joined as ' + r.role.toLowerCase() + '.'); await loadSession(r.orgId); location.hash = '#/overview'; }
    catch (e) { toast(e.message, true); location.hash = '#/overview'; }
  }

  /* ---------------- audit ---------------- */
  VIEWS.audit = async el => {
    crumb(['audit']);
    if (!admin()) { el.innerHTML = '<div class="ph"><div><h1>Audit log</h1></div></div><div class="card"><div class="empty">The audit log is visible to owners and administrators.</div></div>'; return; }
    const L = await get('/audit');
    el.innerHTML = `<div class="ph"><div><h1>Audit log</h1><p>Append-only record of every administrative action. Secrets are never logged.</p></div></div>
      <div class="card">${L.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
        ${L.map(a => `<tr><td>${new Date(a.created_at).toLocaleString()}</td><td class="mono">${esc(a.actor_type)} ${esc(short(a.actor_id))}</td><td><span class="code-tag">${esc(a.action)}</span></td><td class="mono">${esc(a.target_id ? short(a.target_id) : '')}</td><td class="mono" style="max-width:320px;overflow:hidden;text-overflow:ellipsis">${esc(JSON.stringify(a.detail) === '{}' ? '' : JSON.stringify(a.detail))}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No entries.</div>'}</div>`;
  };

  /* ---------------- settings ---------------- */
  VIEWS.settings = async el => {
    crumb(['settings']);
    const org = await get('');
    el.innerHTML = `${stopBanner()}
      <div class="ph"><div><h1>Settings</h1><p>Organization and account.</p></div></div>
      <div class="card"><div class="card-h"><h2>Organization</h2></div><div class="card-b form">
        <label class="fld"><span>Name</span><input id="oname" maxlength="64" value="${esc(org.name)}"${admin() ? '' : ' disabled'}></label>
        <div class="fld"><span>Your role</span><input value="${org.role}" disabled></div>
        ${admin() ? '<div class="form-act full"><button class="btn btn-primary btn-xs" id="osave">Save</button></div>' : ''}
      </div></div>
      <div class="card ${org.emergencyStop ? 'banner-bad' : ''}"><div class="card-h"><h2>Emergency stop</h2></div><div class="rows"><div class="row"><div class="grow"><b>${org.emergencyStop ? 'Active: every transaction is denied' : 'Inactive'}</b><small>Denies every evaluation and execution request of every agent, and blocks the use of authorizations already issued. Admins can activate it; only owners can lift it.</small></div>
        ${org.emergencyStop ? (owner() ? '<button class="btn btn-primary btn-xs" id="estop" data-on="0">Lift the stop</button>' : '') : admin() ? '<button class="btn btn-danger btn-xs" id="estop" data-on="1">Stop all agents</button>' : ''}</div></div></div>
      <div class="card"><div class="card-h"><h2>Public live feed</h2></div><div class="rows"><div class="row"><div class="grow"><b>${org.publicFeed ? 'Sharing anonymized decisions' : 'Not sharing'}</b><small>When on, each decision of this organization appears on <a href="https://www.intercepting.xyz/live" target="_blank" rel="noopener">intercepting.xyz/live</a> with its decision, rule codes, programs and a value range only. Never the organization, agent, wallet, key or exact amount.</small></div>
        ${admin() ? `<button class="btn ${org.publicFeed ? 'btn-ghost' : 'btn-primary'} btn-xs" id="pfeed" data-on="${org.publicFeed ? '0' : '1'}">${org.publicFeed ? 'Stop sharing' : 'Share'}</button>` : ''}</div></div></div>
      <div class="card"><div class="card-h"><h2>Account</h2></div><div class="kv">
        <div>Signed in as</div><div>${esc(S.session.user.display)}</div>
        ${S.session.user.email ? `<div>Email</div><div>${esc(S.session.user.email)}</div>` : ''}${S.session.user.wallet ? `<div>Wallet</div><div class="mono">${esc(S.session.user.wallet)}</div>` : ''}
        <div>User ID</div><div class="mono">${esc(S.session.user.id)}</div><div>Organization ID</div><div class="mono">${esc(org.id)}</div>
      </div><div class="rows"><div class="row"><div class="grow"><b>Sign out</b><small>Ends this session.</small></div><button class="btn btn-ghost btn-xs" id="so2">Sign out</button></div></div></div>`;
    const os = el.querySelector('#osave');
    os && os.addEventListener('click', async () => { try { await api('PATCH', o(''), { name: el.querySelector('#oname').value.trim() }); toast('Saved.'); await loadSession(S.org.id); render(); } catch (e) { toast(e.message, true); } });
    const es = el.querySelector('#estop');
    es && es.addEventListener('click', async () => {
      const on = es.dataset.on === '1';
      if (on && !(await confirmBox('Stop all agents?', 'Every transaction from every agent of this organization will be denied until an owner lifts the stop.', 'Stop all agents', true))) return;
      try { await post('/emergency-stop', { active: on }); toast(on ? 'Emergency stop activated.' : 'Emergency stop lifted.'); await loadSession(S.org.id); render(); } catch (e) { toast(e.message, true); }
    });
    const pf = el.querySelector('#pfeed');
    pf && pf.addEventListener('click', async () => { try { await api('PATCH', o(''), { publicFeed: pf.dataset.on === '1' }); toast(pf.dataset.on === '1' ? 'Anonymized decisions now appear on the live feed.' : 'Stopped sharing.'); render(); } catch (e) { toast(e.message, true); } });
    el.querySelector('#so2').addEventListener('click', () => $('#signout').click());
  };

  /* ---------------- command palette ---------------- */
  function cmd() {
    const box = $('#cmd'), q = $('#cmd-q'), ul = $('#cmd-list');
    let sel = 0, items = [];
    const all = () => NAV.flatMap(g => g.items).filter(i => i.id).map(i => ({ t: i.t, h: '#/' + i.id, s: 'Page' })).concat([{ t: 'Documentation', h: DOCS, s: 'Link' }, { t: 'OpenAPI', h: API + '/v1/openapi.json', s: 'Link' }]);
    const draw = () => {
      const s = q.value.toLowerCase(); items = all().filter(i => i.t.toLowerCase().includes(s)).slice(0, 12); sel = Math.min(sel, Math.max(0, items.length - 1));
      ul.innerHTML = items.map((i, k) => `<li><a href="${i.h}"${i.h.startsWith('http') ? ' target="_blank" rel="noopener"' : ''} class="${k === sel ? 'is-sel' : ''}">${esc(i.t)}<small>${i.s}</small></a></li>`).join('') || '<li class="menu-empty">No results</li>';
    };
    const open = () => { box.hidden = false; q.value = ''; sel = 0; draw(); q.focus(); };
    const close = () => { box.hidden = true; };
    q.addEventListener('input', () => { sel = 0; draw(); });
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      if (e.key === 'Enter' && items[sel]) { const it = items[sel]; close(); it.h.startsWith('http') ? window.open(it.h) : (location.hash = it.h); }
    });
    box.addEventListener('click', e => { if (e.target === box || e.target.closest('a')) close(); });
    $('#open-cmd').addEventListener('click', open);
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !$('#ws').hidden) { e.preventDefault(); box.hidden ? open() : close(); }
      if (e.key === 'Escape') { close(); $('#modal').hidden = true; closeMenus(); }
    });
  }

  /* ---------------- menus ---------------- */
  function closeMenus() { $('#bell-menu').hidden = true; $('#user-menu').hidden = true; }
  function menus() {
    $('#bell').addEventListener('click', async e => {
      e.stopPropagation(); const m = $('#bell-menu'), was = m.hidden; closeMenus();
      if (!was) return;
      m.hidden = false; m.innerHTML = '<p class="menu-empty">Loading…</p>';
      try {
        const P = await get('/evaluations?pending=1&limit=5');
        m.innerHTML = P.length ? P.map(d => `<a class="mi" href="#/activity/${d.id}"><span>${usd(d.valueUsd)} · approval required<small>${ago(d.createdAt)}</small></span></a>`).join('') + '<a href="#/approvals" style="color:var(--fg)">Open approvals →</a>' : '<p class="menu-empty">No pending approvals.</p>';
      } catch (err) { m.innerHTML = `<p class="menu-empty">${esc(err.message)}</p>`; }
    });
    $('#avatar').addEventListener('click', e => { e.stopPropagation(); const m = $('#user-menu'), was = m.hidden; closeMenus(); m.hidden = !was; });
    document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenus(); });
    $('#sb-toggle').addEventListener('click', () => {
      const s = $('.shell');
      if (matchMedia('(max-width: 860px)').matches) { s.classList.remove('is-collapsed'); s.classList.toggle('is-mobile-open'); }
      else { s.classList.toggle('is-collapsed'); try { localStorage.setItem('ix-sb', s.classList.contains('is-collapsed') ? '1' : '0'); } catch (e) {} }
    });
    $('#sb-scrim').addEventListener('click', () => $('.shell').classList.remove('is-mobile-open'));
    const lx = $('.sb-l-x'); lx && lx.addEventListener('click', () => { $('#sb-latest').remove(); try { localStorage.setItem('ix-latest', '1'); } catch (e) {} });
    try { if (localStorage.getItem('ix-sb') === '1') $('.shell').classList.add('is-collapsed'); if (localStorage.getItem('ix-latest') === '1') $('#sb-latest').remove(); } catch (e) {}
    $('#org-select').addEventListener('change', async e => {
      const v = e.target.value;
      if (v === '__new') {
        e.target.value = S.org.id;
        modal('New organization', `<form class="form" id="nof"><label class="fld full"><span>Name</span><input name="name" maxlength="64" required></label><div class="form-act full"><button type="button" class="btn btn-ghost btn-xs" data-x>Cancel</button><button class="btn btn-primary btn-xs">Create</button></div></form>`,
          (box, close) => box.querySelector('#nof').addEventListener('submit', async ev => {
            ev.preventDefault();
            try { const r = await api('POST', '/orgs', { name: new FormData(ev.target).get('name') }); close(); await loadSession(r.id); location.hash = '#/overview'; render(); } catch (err) { toast(err.message, true); }
          }));
        return;
      }
      selectOrg(v); location.hash = '#/overview'; render();
    });
  }
  function selectOrg(id) {
    S.org = S.session.organizations.find(x => x.id === id) || S.session.organizations[0];
    try { localStorage.setItem('ix-org', S.org.id); } catch (e) {}
  }
  async function loadSession(preferOrg) {
    S.session = await api('GET', '/auth/session');
    if (!S.session.user) return location.reload();
    let saved = null; try { saved = localStorage.getItem('ix-org'); } catch (e) {}
    selectOrg(preferOrg || (S.org && S.org.id) || saved);
  }

  /* ---------------- shared with playground.js ---------------- */
  window.ixKit = { $, esc, short, usd, ago, toast, modal, copy, confirmBox, crumb, route, get, post, api, o, S, VIEWS, ic, checksTable, effectLine, admin, issues, API };

  /* ---------------- boot ---------------- */
  window.ixConsole = {
    async start(s) {
      S.session = s;
      const u = s.user, label = u.email || u.wallet || u.display;
      const initials = (u.email ? u.email[0] : (u.wallet || 'IX').slice(0, 2)).toUpperCase();
      $('#avatar').textContent = initials; $('#avatar2').textContent = initials;
      $('#mu-name').textContent = short(label); $('#mu-kind').textContent = u.email ? 'Email' : u.wallet ? 'Wallet' : 'Privy account';
      let saved = null; try { saved = localStorage.getItem('ix-org'); } catch (e) {}
      selectOrg(saved);
      if (!started) { started = true; menus(); cmd(); addEventListener('hashchange', render); }
      await refreshPending();
      render();
    },
  };
  dispatchEvent(new Event('ix:console-ready'));
})();
