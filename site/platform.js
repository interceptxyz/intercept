// Platform section: a hatched bento of three live diagrams (vanilla port of the
// ink-orbit features layout, rewritten for Intercept). Everything shown is
// illustrative; nothing here reads real data.
(function () {
  const root = document.getElementById('ix-platform');
  if (!root) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DOCS = 'https://docs.intercepting.xyz';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const brackets = '<span class="ib-c ib-c-tl"></span><span class="ib-c ib-c-tr"></span><span class="ib-c ib-c-bl"></span><span class="ib-c ib-c-br"></span>';
  const mark = (x, y, s) => `<image href="/mark.png" x="${x}" y="${y}" width="${s}" height="${s}"/>`;
  const pkt = (d, dur, begin) => reduce ? '' : `<circle r="2.2" class="ib-pkt"><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${d}"/></circle>`;

  /* ---------------- card 1: agents -> Intercept -> decisions ---------------- */
  const agents = [
    { x: 58, y: 38, name: 'agent-01 · swap 2,400 USDC' },
    { x: 104, y: 22, name: 'agent-02 · rebalancing' },
    { x: 150, y: 40, name: 'agent-03 · open perp 3x' },
    { x: 46, y: 92, name: 'agent-04 · LP deposit' },
    { x: 146, y: 114, name: 'agent-05 · idle' },
  ];
  const L1 = 'M117,67 C196,67 210,100 262,100', L2 = 'M117,73 C186,73 206,120 262,120';
  const R1 = 'M378,100 C412,100 418,86 450,86', R2 = 'M378,120 C412,120 418,134 450,134';
  const rays = [-62, -38, -14, 14, 38, 62].map(a => {
    const r = d => d * Math.PI / 180;
    return `<path d="M320,110 L${320 + Math.sin(r(a)) * 260},${110 - Math.cos(r(a)) * 260} L${320 + Math.sin(r(a + 7)) * 260},${110 - Math.cos(r(a + 7)) * 260}Z" fill="url(#ib-rays)" opacity=".5"/>`;
  }).join('');
  const agentSvg = agents.map((m, i) => `
    <g class="ib-av" tabindex="0" role="img" aria-label="${esc(m.name)}">
      <rect x="${m.x - 10}" y="${m.y - 10}" width="20" height="20" rx="5" class="ib-node"/>
      <rect x="${m.x - 4.5}" y="${m.y - 3}" width="9" height="6" rx="1.5" fill="none" stroke="var(--ib-soft)" stroke-width="1"/>
      <circle cx="${m.x - 2}" cy="${m.y}" r=".9" fill="var(--ib-ink)"/><circle cx="${m.x + 2}" cy="${m.y}" r=".9" fill="var(--ib-ink)"/>
      <circle cx="${m.x + 8}" cy="${m.y + 8}" r="2.6" fill="${i === 4 ? 'var(--ib-faint)' : 'var(--ib-ink)'}" stroke="var(--ib-paper)" class="${i === 4 ? '' : 'ib-presence'}"/>
      <g class="ib-av-tip" transform="translate(${m.x},${m.y - 18})">
        <rect x="${-m.name.length * 2.45 - 6}" y="-9" width="${m.name.length * 4.9 + 12}" height="14" rx="2" fill="var(--ib-inv)"/>
        <text x="0" y="1" text-anchor="middle" font-size="7.5" fill="var(--ib-inv-ink)" font-family="var(--ib-mono)">${esc(m.name)}</text>
      </g>
    </g>`).join('');

  const CODES = ['SEC_UNLIMITED_APPROVAL', 'RISK_MAX_TX_SIZE', 'SEC_PROTOCOL_NOT_ALLOWED', 'RISK_SLIPPAGE'];
  function decision(n) {
    const k = n % 7;
    return k === 3 ? { v: 'blocked', code: CODES[(n / 7 | 0) % CODES.length] } : k === 6 ? { v: 'requires_approval', code: 'RISK_DAILY_LIMIT' } : { v: 'approved', code: '' };
  }
  function stack(n) {
    return [2, 1, 0].map(k => {
      const d = decision(n - k);
      let inner = '<rect width="138" height="102" rx="3" fill="var(--ib-raise)" stroke="var(--ib-line-strong)"/>';
      if (k === 0) {
        const tone = d.v === 'blocked' ? 'var(--ib-block)' : d.v === 'requires_approval' ? 'var(--ib-soft)' : 'var(--ib-ink)';
        const chk = (y, label, ok) => `<text x="10" y="${y}" font-size="7" fill="var(--ib-muted)" font-family="var(--ib-mono)">${label}</text>` +
          `<text x="128" y="${y}" text-anchor="end" font-size="7" fill="${ok ? 'var(--ib-soft)' : 'var(--ib-block)'}" font-family="var(--ib-mono)">${ok ? 'pass' : 'fail'}</text>`;
        const riskOk = !(d.code.startsWith('RISK') && d.v === 'blocked'), secOk = !(d.code.startsWith('SEC') && d.v === 'blocked');
        inner += `<text x="10" y="16" font-size="7" fill="var(--ib-muted)" font-family="var(--ib-mono)">DECISION #${n}</text>` +
          `<rect x="10" y="24" width="${d.v === 'requires_approval' ? 92 : d.v === 'blocked' ? 52 : 60}" height="13" rx="2" fill="none" stroke="${tone}"/>` +
          `<text x="15" y="33" font-size="7" fill="${tone}" font-family="var(--ib-mono)">${d.v}</text>` +
          chk(52, 'simulation', true) + chk(64, 'risk engine', riskOk) + chk(76, 'security engine', secOk) +
          `<line x1="10" y1="83" x2="128" y2="83" stroke="var(--ib-line-strong)"/>` +
          `<text x="10" y="94" font-size="6.5" fill="${d.code ? tone : 'var(--ib-faint)'}" font-family="var(--ib-mono)">${d.code || 'signed · sent onchain'}</text>`;
      }
      return `<g transform="translate(${450 + k * 12},${40 - k * 10})" opacity="${1 - k * 0.25}"><g class="ib-sheet${k === 0 ? ' ib-sheet-new' : ''}">${inner}</g></g>`;
    }).join('');
  }

  const flowCard = `
  <div class="ib-frame ib-frame-hover ib-wide">${brackets}
    <div class="ib-card" style="padding:0;overflow:hidden">
      <svg class="ib-diagram" viewBox="0 0 640 178" role="img" aria-label="Agents propose transactions; Intercept evaluates each one and issues a decision">
        <defs>
          <radialGradient id="ib-glowg" cx="320" cy="110" r="190" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--ib-raise)"/><stop offset="1" stop-color="var(--ib-raise)" stop-opacity="0"/></radialGradient>
          <linearGradient id="ib-rays" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ib-line-strong)" stop-opacity=".55"/><stop offset="1" stop-color="var(--ib-line-strong)" stop-opacity="0"/></linearGradient>
        </defs>
        <rect width="640" height="178" fill="url(#ib-glowg)"/>${rays}
        <g data-side="left">
          <rect x="20" y="8" width="170" height="130" fill="transparent"/>
          ${agents.map(m => `<line x1="${m.x}" y1="${m.y}" x2="104" y2="70" stroke="var(--ib-line-strong)" stroke-dasharray="2 3"/>`).join('')}
          <g transform="translate(91,57)"><rect width="26" height="26" rx="5" class="ib-node"/><text x="13" y="16.5" text-anchor="middle" font-size="7" fill="var(--ib-soft)" font-family="var(--ib-mono)">API</text></g>
          ${agentSvg}
        </g>
        <path d="${L1}" class="ib-flow" data-l/><path d="${L2}" class="ib-flow ib-dash" data-l/>
        <path d="${R1}" class="ib-flow" data-r/><path d="${R2}" class="ib-flow ib-dash" data-r/>
        ${pkt(L1, 2.2, 0)}${pkt(L2, 2.8, .35)}${pkt(R1, 2.2, .7)}${pkt(R2, 2.8, 1.05)}
        <g transform="translate(262,88)">
          <rect x="-4" y="-4" width="124" height="52" rx="8" fill="none" stroke="var(--ib-line)" class="${reduce ? '' : 'ib-glow'}"/>
          <rect width="116" height="44" rx="6" class="ib-node"/>
          ${mark(12, 13, 18)}
          <text x="36" y="26" font-size="8.5" letter-spacing="1.4" font-weight="600" fill="var(--ib-soft)" font-family="var(--ib-sans)">INTERCEPT</text>
          <path d="M100 18l4 4-4 4" fill="none" stroke="var(--ib-muted)" stroke-width="1.3"/>
        </g>
        <g data-side="right" id="ib-stack">${stack(1284)}</g>
      </svg>
      <div class="ib-wide-copy">
        <a href="/product#risk-engine"><h3>Risk Engine <span class="ib-arr">→</span></h3><p>Evaluates each proposed transaction against the agent’s financial boundaries: position size, leverage, daily spending, slippage, exposure and drawdown.</p></a>
        <a href="/product#transaction-firewall"><h3>Transaction Firewall <span class="ib-arr">→</span></h3><p>Pre-execution security: authorized programs and recipients, unauthorized transfers, risky approvals and permission changes, checked before signing.</p></a>
      </div>
    </div>
  </div>`;

  /* ---------------- card 2: Intercept Network ---------------- */
  const tools = ['Agents', 'Wallets', 'Protocols', 'Operators'];
  const tiles = [{ x: 66, y: 34 }, { x: 66, y: 116 }, { x: 234, y: 34 }, { x: 234, y: 116 }];
  const tpath = i => { const t = tiles[i], dir = t.x < 150 ? -1 : 1; return `M${150 + dir * 17},75 H${150 + dir * 42} V${t.y} H${t.x - dir * 15}`; };
  const glyph = i => [
    '<rect x="-5" y="-4" width="10" height="8" rx="2"/><path d="M-2 0h.01M2 0h.01" stroke-width="2"/>',
    '<rect x="-6.5" y="-5" width="13" height="10" rx="1.5"/><path d="M2 -1h4.5v3H2z"/>',
    '<path d="M0 -6.5 5.6 -3.2v6.4L0 6.5-5.6 3.2v-6.4z"/>',
    '<circle cx="0" cy="-2.5" r="2.8"/><path d="M-5.5 6c.8-3 2.8-4.4 5.5-4.4S4.7 3 5.5 6"/>',
  ][i];
  const netCard = `
  <a class="ib-frame ib-frame-hover" href="/product#intercept-network">${brackets}
    <div class="ib-card">
      <svg class="ib-diagram" viewBox="0 0 300 150" role="img" aria-label="Intercept Network: a shared threat registry synced to agents, wallets, protocols and operators">
        ${tiles.map((_, i) => `<path d="${tpath(i)}" class="ib-flow" data-net="${i}"/>`).join('')}
        <g id="ib-netpkt"></g>
        <g transform="translate(133,58)"><rect width="34" height="34" rx="7" class="ib-node"/>${mark(8, 8, 18)}</g>
        ${tiles.map((t, i) => `<g class="ib-tool" data-tool="${i}">
          <rect x="${t.x - 15}" y="${t.y - 15}" width="30" height="30" rx="6" class="ib-node"/>
          <g transform="translate(${t.x},${t.y})" fill="none" stroke="var(--ib-ink)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${glyph(i)}</g>
          <text x="${t.x}" y="${t.y + (t.y < 75 ? -21 : 28)}" text-anchor="middle" font-size="8" fill="var(--ib-muted)" font-family="var(--ib-sans)" class="ib-tool-t">${tools[i]}</text>
        </g>`).join('')}
        <text x="150" y="106" text-anchor="middle" font-size="6.5" fill="var(--ib-faint)" font-family="var(--ib-mono)" id="ib-netlabel">threat registry</text>
      </svg>
      <div class="ib-copy"><h3>Intercept Network <span class="ib-arr">→</span></h3><p>Future: a shared threat intelligence layer, so a threat verified once can be blocked for every connected agent and protocol.</p></div>
    </div>
  </a>`;

  /* ---------------- card 3: continuous monitoring ---------------- */
  const W = 300, H = 130, P = 14;
  const vals = [34, 38, 36, 45, 52, 49, 58, 63, 61, 72, 79, 86];
  const X = i => P + i / (vals.length - 1) * (W - P * 2), Y = v => H - P - v / 100 * (H - P * 2);
  const pts = vals.map((v, i) => [X(i), Y(v)]);
  let line = '';
  pts.forEach(([x, y], i) => { if (!i) { line = `M${x.toFixed(1)},${y.toFixed(1)}`; return; } const [px, py] = pts[i - 1], cx = (px + x) / 2; line += ` C${cx.toFixed(1)},${py.toFixed(1)} ${cx.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`; });
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H - P} L${pts[0][0].toFixed(1)},${H - P} Z`;
  const monCard = `
  <a class="ib-frame ib-frame-hover" href="/product#autonomous-guardian" id="ib-mon">${brackets}
    <div class="ib-card">
      <svg class="ib-diagram ib-chart" viewBox="0 0 ${W} ${H + 6}" role="img" aria-label="Illustrative chart: exposure rising toward the policy limit until a circuit breaker trips">
        <defs><linearGradient id="ib-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ib-ink)" stop-opacity=".12"/><stop offset="1" stop-color="var(--ib-ink)" stop-opacity="0"/></linearGradient></defs>
        ${[.25, .5, .75].map(g => `<line x1="${P}" x2="${W - P}" y1="${H * g}" y2="${H * g}" stroke="var(--ib-line)"/>`).join('')}
        <line x1="${P}" x2="${W - P}" y1="${Y(100)}" y2="${Y(100)}" stroke="var(--ib-line-strong)"/>
        <text x="${P}" y="${Y(100) - 4}" font-size="7" fill="var(--ib-faint)" font-family="var(--ib-mono)">POLICY LIMIT</text>
        <line x1="${P}" x2="${W - P}" y1="${Y(80)}" y2="${Y(80)}" stroke="var(--ib-block)" stroke-opacity=".6" stroke-dasharray="2 3"/>
        <text x="${P}" y="${Y(80) + 11}" font-size="7" fill="var(--ib-block)" font-family="var(--ib-mono)">BREAKER 80%</text>
        <path d="${area}" fill="url(#ib-area)"/>
        <path d="${line}" fill="none" stroke="var(--ib-ink)" stroke-width="1.4" pathLength="1" class="ib-line-draw" opacity=".85"/>
        <line id="ib-cross" y1="8" y2="${H - P}" stroke="var(--ib-ink)" stroke-opacity=".35" visibility="hidden"/>
        ${reduce ? '' : `<circle cx="${pts[11][0]}" cy="${pts[11][1]}" r="7" fill="var(--ib-block)" opacity=".2" class="ib-glow" id="ib-pulse"/>`}
        <circle id="ib-dot" r="3.2" fill="var(--ib-raise)" stroke="var(--ib-ink)" stroke-width="1.5"/>
        <g id="ib-tip"><rect x="-38" y="-11" width="76" height="15" rx="2" fill="var(--ib-inv)"/><text x="0" y="-1" text-anchor="middle" font-size="7.5" fill="var(--ib-inv-ink)" font-family="var(--ib-mono)"></text></g>
      </svg>
      <div class="ib-copy"><h3>Monitor and protect <span class="ib-arr">→</span></h3><p>Every evaluation is recorded in the agent’s history. Thresholds can escalate to human approval; automated responses such as circuit breakers are planned.</p></div>
    </div>
  </a>`;

  root.innerHTML = `
  <div class="ib-shell"><section class="ib-sec" aria-labelledby="ib-h">
    <div class="ib-reveal">
      <div class="ib-head">
        <span class="ib-tag">How it works</span>
        <h2 class="ib-h2" id="ib-h"><span>One integration.</span><span class="ib-muted">Programmable protection.</span></h2>
        <p class="ib-lede">Register an agent, configure its financial and security policies in the dashboard, and give it a dedicated API key. The agent submits every proposed transaction to Intercept and receives a decision before execution. You never have to build your own risk system or transaction firewall.</p>
      </div>
      <div class="ib-bento">${flowCard}${netCard}${monCard}</div>
      <p class="ib-note">Illustrative diagrams. Live: console, agents, versioned policies, scoped API keys, transaction decoding and simulation, decisions, approvals and signed execution authorizations. In development: protocol adapters and a hosted signer. Future: automated incident response and the Intercept Network.</p>
    </div>
  </section></div>`;

  /* ---------------- behaviour ---------------- */
  const reveal = root.querySelector('.ib-reveal');
  let seen = false;
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { seen = true; reveal.dataset.in = 'true'; root.querySelector('#ib-mon').dataset.in = 'true'; io.disconnect(); } }, { threshold: 0.12 });
  io.observe(reveal);

  // hover a side of the flow card to light its connectors
  root.querySelectorAll('[data-side]').forEach(g => {
    const sel = g.dataset.side === 'left' ? '[data-l]' : '[data-r]';
    g.addEventListener('mouseenter', () => root.querySelectorAll(sel).forEach(p => p.classList.add('ib-flow-on')));
    g.addEventListener('mouseleave', () => root.querySelectorAll(sel).forEach(p => p.classList.remove('ib-flow-on')));
  });

  // decisions keep printing
  let n = 1284;
  const st = root.querySelector('#ib-stack');
  if (!reduce) setInterval(() => { if (seen && !document.hidden) st.innerHTML = stack(++n); }, 2800);

  // network: sync one participant at a time, or the hovered one
  let auto = 0, hover = -1;
  const netLabel = root.querySelector('#ib-netlabel'), netPkt = root.querySelector('#ib-netpkt');
  function setNet() {
    const on = hover >= 0 ? hover : reduce ? -1 : auto;
    root.querySelectorAll('[data-net]').forEach(p => p.classList.toggle('ib-flow-on', +p.dataset.net === on));
    root.querySelectorAll('[data-tool]').forEach(t => t.classList.toggle('ib-tool-on', +t.dataset.tool === on));
    netLabel.textContent = on >= 0 ? 'syncing · ' + tools[on].toLowerCase() : 'threat registry';
    netPkt.innerHTML = on >= 0 && !reduce ? `<circle r="2.2" class="ib-pkt"><animateMotion dur="1.1s" repeatCount="indefinite" path="${tpath(on)}"/></circle>` : '';
  }
  root.querySelectorAll('[data-tool]').forEach(t => {
    t.addEventListener('mouseenter', () => { hover = +t.dataset.tool; setNet(); });
    t.addEventListener('mouseleave', () => { hover = -1; setNet(); });
  });
  if (!reduce) setInterval(() => { if (hover < 0) { auto = (auto + 1) % 4; setNet(); } }, 1700);
  setNet();

  // monitoring chart: scrub
  const svg = root.querySelector('.ib-chart'), dot = root.querySelector('#ib-dot'), tip = root.querySelector('#ib-tip'), cross = root.querySelector('#ib-cross');
  function point(i, hovering) {
    const [x, y] = pts[i];
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', hovering ? 'visible' : 'hidden');
    const tx = Math.min(W - 40, Math.max(40, x)), ty = y < 34 ? y + 22 : y - 12;
    tip.setAttribute('transform', `translate(${tx},${ty})`);
    tip.querySelector('text').textContent = vals[i] >= 80 ? `${vals[i]}% · reduce-only` : `t-${vals.length - 1 - i} · ${vals[i]}% of limit`;
    tip.querySelector('rect').setAttribute('fill', vals[i] >= 80 ? 'var(--ib-block)' : 'var(--ib-inv)');
  }
  svg.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W;
    let best = 0; pts.forEach((p, i) => { if (Math.abs(p[0] - x) < Math.abs(pts[best][0] - x)) best = i; });
    point(best, true);
  });
  svg.addEventListener('pointerleave', () => point(pts.length - 1, false));
  point(pts.length - 1, false);
})();

// narrow screens: the wide diagram is unreadable at full width, so frame the hub and decisions
(function () {
  const svg = document.querySelector('#ix-platform .ib-wide .ib-diagram');
  if (!svg) return;
  const fit = () => svg.setAttribute('viewBox', svg.clientWidth && svg.parentElement.clientWidth < 520 ? '232 18 400 150' : '0 0 640 178');
  new ResizeObserver(fit).observe(svg.parentElement); fit();
})();
