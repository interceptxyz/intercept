// /product: every visual here is a scripted, illustrative demonstration.
(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = s => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sleep = ms => new Promise(r => setTimeout(r, reduce ? 0 : ms));
  const usd = n => '$' + Math.round(n).toLocaleString('en-US');
  const onView = (el, fn, th = 0.25) => {
    if (!el) return;
    const io = new IntersectionObserver(es => es.forEach(e => fn(e.isIntersecting)), { threshold: th });
    io.observe(el);
  };
  const svgEl = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const box = (x, y, w, h, title, sub, cls = 'v-box') =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" class="${cls}"/>` +
    `<text x="${x + w / 2}" y="${y + h / 2 + (sub ? -2 : 5)}" text-anchor="middle" class="v-t">${esc(title)}</text>` +
    (sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 16}" text-anchor="middle" class="v-s">${esc(sub)}</text>` : '');

  /* ============================== hero visual ============================== */
  (function hero() {
    const svg = $('#hero-viz');
    if (!svg) return;
    const STAGES = [{ x: 440, t: 'Simulation' }, { x: 570, t: 'Risk Engine' }, { x: 700, t: 'Firewall' }];
    const LANES = [150, 180, 210];
    let s = '';
    s += box(36, 140, 170, 80, 'Autonomous agent', 'proposes transactions');
    s += `<rect x="330" y="56" width="470" height="248" rx="8" class="v-box" style="fill:rgba(10,13,17,.6)"/>`;
    s += `<text x="350" y="84" class="v-k">INTERCEPT EXECUTION LAYER</text>`;
    STAGES.forEach(st => {
      s += `<text x="${st.x}" y="118" text-anchor="middle" class="v-s">${st.t}</text>`;
      s += `<line x1="${st.x - 13}" y1="128" x2="${st.x - 13}" y2="268" class="v-line-2"/><line x1="${st.x + 13}" y1="128" x2="${st.x + 13}" y2="268" class="v-line-2"/>`;
      LANES.forEach((y, i) => { s += `<rect x="${st.x - 7}" y="${y - 9}" width="14" height="18" rx="2" class="v-cell" data-cell="${st.x}-${i}"/>`; });
    });
    s += `<path d="M760 160 L780 180 L760 200 L740 180Z" class="v-box-hi"/><text x="760" y="232" text-anchor="middle" class="v-s">Decision</text>`;
    s += box(910, 140, 170, 80, 'Chain', 'executes approved', 'v-box-hi');
    s += box(910, 22, 170, 56, 'Owner approval', '', 'v-box');
    s += box(910, 282, 170, 56, 'Intercepted', '', 'v-box');
    s += `<circle cx="922" cy="50" r="3.5" class="v-hold"/><circle cx="922" cy="310" r="3.5" class="v-bad"/><circle cx="922" cy="180" r="3.5" class="v-ok"/>`;
    LANES.forEach(y => { s += `<path d="M206 ${y} H740" class="v-line"/>`; });
    s += `<path id="hp-ok" d="M780 180 H908" class="v-line-2"/>`;
    s += `<path id="hp-hold" d="M760 160 C760 90 820 50 908 50" class="v-line"/>`;
    s += `<path id="hp-bad" d="M760 200 C760 270 820 310 908 310" class="v-line"/>`;
    s += `<g id="hv-tokens"></g><g id="hv-labels"></g>`;
    svg.innerHTML = s;
    const layer = svg.querySelector('#hv-tokens'), lab = svg.querySelector('#hv-labels');
    const branch = { ok: svg.querySelector('#hp-ok'), hold: svg.querySelector('#hp-hold'), bad: svg.querySelector('#hp-bad') };
    const COL = { ok: 'var(--ok)', hold: 'var(--hold)', bad: 'var(--bad)' };
    const CODES = { bad: ['RISK_MAX_LEVERAGE', 'SEC_UNLIMITED_APPROVAL', 'SEC_BLOCKED_ADDRESS', 'RISK_DAILY_LIMIT'], hold: ['requires_approval'] };
    let toks = [], last = 0, nextSpawn = 0, raf = 0, visible = true, n = 0;

    function spawn() {
      const r = Math.random();
      const out = r < 0.62 ? 'ok' : r < 0.82 ? 'bad' : 'hold';
      const failAt = out === 'bad' ? (Math.random() < 0.5 ? 1 : 2) : out === 'hold' ? 1 : -1;
      const lane = n++ % 3;
      const el = svgEl('rect', { width: 16, height: 4, rx: 1, fill: 'var(--fg)' }, layer);
      toks.push({ el, lane, x: 206, stage: 0, wait: 0, out, failAt, phase: 'main', t: 0 });
    }
    function cell(stage, lane, on) { const c = svg.querySelector(`[data-cell="${STAGES[stage].x}-${lane}"]`); c && c.classList.toggle('on', on); }
    function label(text, cls, y) {
      const t = svgEl('text', { x: 790, y, class: 'v-s', 'text-anchor': 'start' }, lab);
      t.style.fill = COL[cls]; t.textContent = text; t.style.transition = 'opacity .6s';
      setTimeout(() => { t.style.opacity = 0; }, 1600); setTimeout(() => t.remove(), 2300);
    }
    function step(dt, now) {
      if (now > nextSpawn) { spawn(); nextSpawn = now + 0.9 + Math.random() * 0.9; }
      for (const k of toks) {
        const y = LANES[k.lane];
        if (k.phase === 'main') {
          if (k.wait > 0) {
            k.wait -= dt;
            if (k.wait <= 0) {
              cell(k.stage, k.lane, false);
              if (k.failAt === k.stage) { k.phase = 'converge'; k.t = 0; }
              else k.stage++;
            }
          } else {
            const target = k.stage < 3 ? STAGES[k.stage].x - 22 : 740;
            k.x = Math.min(target, k.x + 120 * dt);
            if (k.x >= target) {
              if (k.stage < 3) { k.wait = 0.32; cell(k.stage, k.lane, true); }
              else { k.phase = 'converge'; k.t = 0; }
            }
          }
          k.el.setAttribute('x', k.x - 16); k.el.setAttribute('y', y - 2);
          if (k.phase === 'converge') { k.cx = k.x; k.cy = y; }
        } else if (k.phase === 'converge') { // glide to the decision node
          k.t = Math.min(1, k.t + dt * 2.6);
          const x = k.cx + (744 - k.cx) * k.t, yy = k.cy + (180 - k.cy) * k.t;
          k.el.setAttribute('x', x - 16); k.el.setAttribute('y', yy - 2);
          if (k.t >= 1) {
            k.phase = 'branch'; k.t = 0; k.path = branch[k.out]; k.len = k.path.getTotalLength();
            k.el.setAttribute('fill', COL[k.out]);
            if (k.out !== 'ok') label(k.out === 'bad' ? CODES.bad[(Math.random() * 4) | 0] : 'requires_approval', k.out, k.out === 'bad' ? 252 : 116);
          }
        } else if (k.phase === 'branch') {
          k.t = Math.min(1, k.t + dt * 110 / k.len);
          const p = k.path.getPointAtLength(k.t * k.len);
          k.el.setAttribute('x', p.x - 8); k.el.setAttribute('y', p.y - 2);
          if (k.t >= 1) { k.phase = 'done'; k.el.style.transition = 'opacity .5s'; k.el.style.opacity = 0; setTimeout(() => k.el.remove(), 600); }
        }
      }
      toks = toks.filter(k => k.phase !== 'done');
    }
    function frame(ts) {
      const now = ts / 1000, dt = Math.min(0.05, now - (last || now)); last = now;
      step(dt, now);
      raf = visible ? requestAnimationFrame(frame) : 0;
    }
    if (reduce) { // static, representative frame
      [[300, 0, 'var(--fg)'], [520, 1, 'var(--fg)'], [640, 2, 'var(--fg)']].forEach(([x, l, f]) => svgEl('rect', { x, y: LANES[l] - 2, width: 16, height: 4, rx: 1, fill: f }, layer));
      return;
    }
    onView(svg, v => { visible = v; if (v && !raf) { last = 0; raf = requestAnimationFrame(frame); } }, 0.05);
  })();

  /* ============================== risk engine ============================== */
  (function risk() {
    const P = { portfolio: 50000, lev: 3, size: 5000, loss: 2, slip: 0.5 };
    const I = id => document.getElementById(id);
    if (!I('r-lev')) return;
    function render() {
      const lev = +I('r-lev').value, size = +I('r-size').value, slip = +I('r-slip').value, loss = +I('r-loss').value;
      I('rv-lev').textContent = lev.toFixed(1) + 'x';
      I('rv-size').textContent = usd(size);
      I('rv-slip').textContent = slip.toFixed(2) + '%';
      I('rv-loss').textContent = loss.toFixed(1) + '%';
      const checks = [
        ['Leverage', `${lev.toFixed(1)}x / max ${P.lev}x`, lev <= P.lev, 'RISK_MAX_LEVERAGE'],
        ['Position size', `${usd(size)} / max ${usd(P.size)}`, size <= P.size, 'RISK_POSITION_SIZE'],
        ['Notional exposure', `${usd(size * lev)} · ${((size * lev) / P.portfolio * 100).toFixed(0)}% of portfolio`, true, ''],
        ['Expected slippage', `${slip.toFixed(2)}% / max ${P.slip}%`, slip <= P.slip, 'RISK_SLIPPAGE'],
        ['Daily loss', `${loss.toFixed(1)}% / max ${P.loss}%`, loss < P.loss, 'RISK_DAILY_LIMIT'],
      ];
      I('risk-checks').innerHTML = checks.map(([l, v, ok, code]) =>
        `<div class="chk${ok ? '' : ' bad'}"><span class="ic"></span><span>${l}</span><span class="cv">${v}</span><span class="cc">${ok ? 'within policy' : code}</span></div>`).join('');
      const fails = checks.filter(c => !c[2]);
      I('risk-verdict').innerHTML = fails.length
        ? `<span class="vd bad">BLOCKED</span><span>Rejected by the Risk Engine · <span class="code-chip">${fails.map(f => f[3]).join(', ')}</span></span>`
        : `<span class="vd ok">APPROVED</span><span>Within every configured boundary. Passed to the Transaction Firewall.</span>`;
    }
    ['r-lev', 'r-size', 'r-slip', 'r-loss'].forEach(id => I(id).addEventListener('input', render));
    render();
  })();

  /* ============================== firewall ============================== */
  (function firewall() {
    const panel = $('#fw-panel');
    if (!panel) return;
    const STEPS = ['Transaction simulation', 'Instruction analysis', 'Recipient verification', 'Program allowlist', 'Permission check'];
    const TX = [
      { fields: [['Incoming transaction', 'Transfer'], ['Amount', '25,000 USDC'], ['Destination', '9vQe…Kx3T · unrecognized'], ['Agent', 'agent-treasury-02']],
        res: ['balances resolved', 'SPL Token · transfer', 'not on allowlist'], fail: 2, verdict: 'bad', why: 'Policy violation: unauthorized recipient', code: 'SEC_BLOCKED_ADDRESS' },
      { fields: [['Incoming transaction', 'Swap'], ['Amount', '120 SOL → USDC'], ['Program', 'Jupiter aggregator · allowlisted'], ['Agent', 'agent-trader-01']],
        res: ['output 16,440 USDC', 'route · 2 hops', 'self · own account', 'allowlisted', 'within session scope'], fail: -1, verdict: 'ok', why: 'All checks passed. Signed and sent onchain.' },
      { fields: [['Incoming transaction', 'Token approval'], ['Amount', 'Unlimited USDC'], ['Delegate', '4Fh2…pQ9a · unverified program'], ['Agent', 'agent-yield-03']],
        res: ['delegate gains spend authority', 'approve · u64::MAX'], fail: 1, verdict: 'bad', why: 'Policy violation: unlimited token approval', code: 'SEC_UNLIMITED_APPROVAL' },
    ];
    let i = 0, running = false, visible = false;
    async function run() {
      if (running) return; running = true;
      while (visible) {
        const t = TX[i % TX.length]; i++;
        const txEl = $('#fw-tx');
        txEl.classList.remove('in'); void txEl.offsetWidth; txEl.classList.add('in');
        txEl.innerHTML = t.fields.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
        $('#fw-steps').innerHTML = STEPS.map(s => `<li><span class="st"></span><span>${s}</span><span class="fw-r"></span></li>`).join('');
        $('#fw-verdict').innerHTML = `<span class="vd wait">EVALUATING</span><span>Execution status pending</span>`;
        const lis = [...document.querySelectorAll('#fw-steps li')];
        for (let k = 0; k < lis.length; k++) {
          if (t.fail >= 0 && k > t.fail) { lis[k].classList.add('is-skip'); lis[k].querySelector('.fw-r').textContent = 'skipped'; continue; }
          lis[k].classList.add('run'); await sleep(650);
          lis[k].classList.remove('run');
          const bad = k === t.fail;
          lis[k].classList.add(bad ? 'bad' : 'ok');
          lis[k].querySelector('.fw-r').textContent = t.res[k] || 'ok';
        }
        await sleep(250);
        $('#fw-verdict').innerHTML = t.verdict === 'ok'
          ? `<span class="vd ok">APPROVED</span><span>${t.why}</span>`
          : `<span class="vd bad">BLOCKED</span><span>${t.why} · <span class="code-chip">${t.code}</span></span>`;
        if (reduce) break;
        await sleep(3600);
      }
      running = false;
    }
    onView(panel, v => { visible = v; if (v) run(); });
  })();

  /* ============================== guardian ============================== */
  (function guardian() {
    const panel = $('#soc-panel');
    if (!panel) return;
    const EVENTS = [
      ['14:31:40', 'info', 'Normal activity', '3 transactions per minute · risk score 12'],
      ['14:32:01', 'warn', 'Abnormal activity detected', '41 transfer requests in 12 seconds, 9 to new recipients'],
      ['14:32:02', 'crit', 'Risk threshold exceeded', 'Risk score 87 · threshold 70'],
      ['14:32:03', 'act', 'Agent permissions suspended', 'Session key revoked · account set to paused'],
      ['14:32:04', 'act', 'Owner notified', 'Escalated for human review · recovery procedure ready'],
    ];
    const spark = $('#soc-spark');
    const pts = [8, 10, 9, 12, 11, 10, 12, 11, 13, 12, 14, 13, 12, 46, 70, 87, 87, 87];
    function sparkline(k) {
      const n = pts.length, use = pts.slice(0, k);
      const d = use.map((v, i) => (i ? 'L' : 'M') + (i / (n - 1) * 520).toFixed(1) + ',' + (66 - v * 0.62).toFixed(1)).join(' ');
      spark.innerHTML = `<line x1="0" x2="520" y1="${66 - 70 * 0.62}" y2="${66 - 70 * 0.62}" stroke="var(--bad)" stroke-opacity=".5" stroke-dasharray="3 4"/>` +
        `<path d="${d}" fill="none" stroke="var(--fg)" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`;
    }
    let running = false, played = false;
    async function play() {
      if (running) return; running = true; played = true;
      const log = $('#soc-log'), st = $('#soc-state'), sc = $('#soc-score');
      log.innerHTML = ''; st.textContent = 'Active'; st.className = ''; sc.textContent = '12'; sc.className = '';
      for (let k = 1; k <= 13; k++) { sparkline(k); await sleep(60); }
      const add = e => { log.insertAdjacentHTML('beforeend', `<li><time>${e[0]}</time><span class="sev ${e[1]}">${{ info: 'info', warn: 'warning', crit: 'critical', act: 'action' }[e[1]]}</span><span class="msg"><b>${e[2]}</b><small>${e[3]}</small></span></li>`); };
      add(EVENTS[0]); await sleep(900);
      add(EVENTS[1]); for (let k = 14; k <= 15; k++) { sparkline(k); await sleep(200); } sc.textContent = '46'; sc.className = 'hold'; st.textContent = 'Under watch'; st.className = 'hold'; await sleep(900);
      add(EVENTS[2]); sparkline(18); sc.textContent = '87'; sc.className = 'bad'; await sleep(900);
      add(EVENTS[3]); st.textContent = 'Suspended'; st.className = 'bad'; await sleep(900);
      add(EVENTS[4]);
      running = false;
    }
    $('#soc-replay').addEventListener('click', play);
    onView(panel, v => { if (v && !played) play(); }, 0.35);
    sparkline(13);
  })();

  /* ============================== network ============================== */
  (function network() {
    const svg = $('#net-viz');
    if (!svg) return;
    const C = { x: 280, y: 210 };
    const TYPES = ['Agent', 'Protocol', 'Wallet', 'Operator', 'Agent', 'Wallet', 'Protocol', 'Agent', 'Operator', 'Wallet'];
    const nodes = TYPES.map((t, i) => {
      const a = -Math.PI / 2 + i / TYPES.length * Math.PI * 2;
      return { t, x: C.x + Math.cos(a) * 215, y: C.y + Math.sin(a) * 160 };
    });
    let s = `<ellipse cx="${C.x}" cy="${C.y}" rx="215" ry="160" class="n-ring"/><ellipse cx="${C.x}" cy="${C.y}" rx="120" ry="88" class="n-ring"/>`;
    nodes.forEach((n, i) => { s += `<line x1="${C.x}" y1="${C.y}" x2="${n.x}" y2="${n.y}" class="n-edge" data-e="${i}"/>`; });
    s += `<rect x="${C.x - 70}" y="${C.y - 30}" width="140" height="60" rx="6" class="v-box-hi" id="n-hub"/>`;
    s += `<text x="${C.x}" y="${C.y - 3}" text-anchor="middle" class="v-t">Threat Registry</text><text x="${C.x}" y="${C.y + 15}" text-anchor="middle" class="v-s" id="n-hub-s">verified signals</text>`;
    nodes.forEach((n, i) => {
      const op = n.t === 'Operator';
      s += op ? `<rect x="${n.x - 9}" y="${n.y - 9}" width="18" height="18" transform="rotate(45 ${n.x} ${n.y})" class="n-node" data-n="${i}"/>`
              : n.t === 'Protocol' ? `<rect x="${n.x - 10}" y="${n.y - 10}" width="20" height="20" rx="3" class="n-node" data-n="${i}"/>`
              : `<circle cx="${n.x}" cy="${n.y}" r="${n.t === 'Agent' ? 10 : 8}" class="n-node" data-n="${i}"/>`;
      const below = n.y > C.y;
      s += `<text x="${n.x}" y="${n.y + (below ? 28 : -18)}" text-anchor="middle" class="v-s">${n.t}</text>`;
    });
    s += '<g id="n-pk"></g>';
    svg.innerHTML = s;
    const pk = svg.querySelector('#n-pk'), status = $('#net-status'), hubS = svg.querySelector('#n-hub-s');
    const N = i => svg.querySelector(`[data-n="${i}"]`), E = i => svg.querySelector(`[data-e="${i}"]`);
    function pulse(from, to, dur) {
      if (reduce) return Promise.resolve();
      const c = svgEl('circle', { r: 3, fill: 'var(--fg)' }, pk);
      return new Promise(res => {
        const t0 = performance.now();
        (function f(now) {
          const k = Math.min(1, (now - t0) / dur);
          c.setAttribute('cx', from.x + (to.x - from.x) * k); c.setAttribute('cy', from.y + (to.y - from.y) * k);
          if (k < 1) requestAnimationFrame(f); else { c.remove(); res(); }
        })(t0);
      });
    }
    let running = false, visible = false, round = 0;
    const ops = nodes.map((n, i) => (n.t === 'Operator' ? i : -1)).filter(i => i >= 0);
    async function cycle() {
      if (running) return; running = true;
      while (visible) {
        const cand = nodes.map((n, i) => i).filter(i => nodes[i].t !== 'Operator');
        const src = cand[round++ % cand.length];
        svg.querySelectorAll('.n-node').forEach(n => n.classList.remove('hit', 'safe'));
        svg.querySelectorAll('.n-edge').forEach(e => e.classList.remove('on'));
        hubS.textContent = 'verified signals';
        N(src).classList.add('hit');
        status.textContent = `${nodes[src].t} reports a malicious program · signed report submitted`;
        E(src).classList.add('on'); await pulse(nodes[src], C, 900);
        status.textContent = 'Independent operators verify the report and its evidence';
        hubS.textContent = 'verifying…';
        ops.forEach(o => E(o).classList.add('on'));
        await Promise.all(ops.map(o => pulse(nodes[o], C, 700)));
        await sleep(400);
        hubS.textContent = 'threat verified';
        status.textContent = 'Signal distributed · connected participants block the program';
        const rest = nodes.map((n, i) => i).filter(i => i !== src);
        await Promise.all(rest.map((i, k) => sleep(k * 70).then(() => { E(i).classList.add('on'); return pulse(C, nodes[i], 650); }).then(() => N(i).classList.add('safe'))));
        status.textContent = `${rest.length} participants protected from the same threat · illustrative`;
        if (reduce) break;
        await sleep(3200);
      }
      running = false;
    }
    onView(svg, v => { visible = v; if (v) cycle(); });
  })();

  /* ============================== simulator ============================== */
  (function simulator() {
    const list = $('#sim-list');
    if (!list) return;
    const S = [
      { name: 'Standard SOL swap', sub: 'Routine rebalancing', tx: [['Action', 'Swap SOL → USDC'], ['Amount', '25 SOL · $4,150'], ['Venue', 'Jupiter · allowlisted'], ['Agent', 'agent-trader-01']],
        risk: [['Position size', '$4,150 / $5,000', 'ok'], ['Leverage', 'none', 'ok'], ['Slippage', '0.12% / 0.5%', 'ok'], ['Daily loss', '0.4% / 2%', 'ok']],
        sec: [['Simulation', 'succeeds', 'ok'], ['Program', 'allowlisted', 'ok'], ['Recipient', 'own account', 'ok'], ['Approvals', 'none requested', 'ok']],
        pol: [], v: 'ok', why: 'Within financial limits and no security findings. Signed and sent.' },
      { name: 'Excessive leverage', sub: 'Perp position at 8x', tx: [['Action', 'Open SOL-PERP long'], ['Amount', '$4,000 margin · 8x'], ['Venue', 'Perps DEX · allowlisted'], ['Agent', 'agent-trader-01']],
        risk: [['Position size', '$4,000 / $5,000', 'ok'], ['Leverage', '8x / max 3x', 'bad'], ['Notional exposure', '$32,000 · 64%', 'hold'], ['Daily loss', '0.4% / 2%', 'ok']],
        sec: [['Simulation', 'succeeds', 'ok'], ['Program', 'allowlisted', 'ok'], ['Recipient', 'own account', 'ok'], ['Approvals', 'none requested', 'ok']],
        pol: ['RISK_MAX_LEVERAGE'], v: 'bad', why: 'A financial risk, not a security threat: the transaction is safe but exceeds the agent\'s leverage policy.' },
      { name: 'Unauthorized transfer', sub: '25,000 USDC to a new address', tx: [['Action', 'Transfer USDC'], ['Amount', '25,000 USDC'], ['Destination', '9vQe…Kx3T · unrecognized'], ['Agent', 'agent-treasury-02']],
        risk: [['Transfer size', '$25,000 · above $10,000', 'hold'], ['Daily outflow', '$25,000 / $30,000', 'ok'], ['Portfolio impact', '50% of balance', 'hold'], ['Daily loss', '0% / 2%', 'ok']],
        sec: [['Simulation', 'succeeds', 'ok'], ['Recipient', 'not on allowlist', 'bad'], ['Address reputation', 'no history', 'hold'], ['Approvals', 'none requested', 'ok']],
        pol: ['SEC_BLOCKED_ADDRESS', 'requireApprovalAboveUsd'], v: 'bad', why: 'The security finding decides: an unrecognized recipient is blocked outright, regardless of approval thresholds.' },
      { name: 'Suspicious smart contract', sub: 'Deposit into an unverified program', tx: [['Action', 'Deposit USDC'], ['Amount', '2,000 USDC'], ['Program', '7Hn1…rT2c · deployed 2h ago'], ['Agent', 'agent-yield-03']],
        risk: [['Position size', '$2,000 / $5,000', 'ok'], ['Concentration', '4% of portfolio', 'ok'], ['Liquidity', 'withdrawal not simulated', 'hold'], ['Daily loss', '0.2% / 2%', 'ok']],
        sec: [['Program', 'not on allowlist', 'bad'], ['Upgrade authority', 'single key, mutable', 'bad'], ['Simulation', 'reassigns token authority', 'bad'], ['Threat registry', 'no reports yet', 'ok']],
        pol: ['SEC_PROTOCOL_NOT_ALLOWED', 'SEC_AUTHORITY_CHANGE'], v: 'bad', why: 'Small amount, within financial limits, and still blocked: the risk is the contract, not the size.' },
      { name: 'Excessive portfolio exposure', sub: 'Concentration above target', tx: [['Action', 'Buy JUP'], ['Amount', '$4,800'], ['Venue', 'Jupiter · allowlisted'], ['Agent', 'agent-trader-01']],
        risk: [['Position size', '$4,800 / $5,000', 'ok'], ['Asset concentration', '38% / 35% soft limit', 'hold'], ['Leverage', 'none', 'ok'], ['Daily loss', '0.9% / 2%', 'ok']],
        sec: [['Simulation', 'succeeds', 'ok'], ['Program', 'allowlisted', 'ok'], ['Recipient', 'own account', 'ok'], ['Approvals', 'none requested', 'ok']],
        pol: ['RISK_POSITION_SIZE · soft'], v: 'hold', why: 'A soft limit is crossed. The transaction is held until the owner or an operator approves it.' },
      { name: 'Daily loss threshold exceeded', sub: 'Circuit breaker active', tx: [['Action', 'Open SOL-PERP short'], ['Amount', '$1,500 margin · 2x'], ['Venue', 'Perps DEX · allowlisted'], ['Agent', 'agent-trader-01']],
        risk: [['Daily loss', '2.3% / max 2%', 'bad'], ['Circuit breaker', 'reduce-only mode', 'bad'], ['Leverage', '2x / 3x', 'ok'], ['Position size', '$1,500 / $5,000', 'ok']],
        sec: [['Simulation', 'succeeds', 'ok'], ['Program', 'allowlisted', 'ok'], ['Recipient', 'own account', 'ok'], ['Approvals', 'none requested', 'ok']],
        pol: ['RISK_DAILY_LIMIT'], v: 'bad', why: 'New risk is refused until the next trading day. Closing or reducing positions is still allowed.' },
    ];
    const VD = { ok: ['ok', 'APPROVED'], bad: ['bad', 'BLOCKED'], hold: ['hold', 'REQUIRES APPROVAL'] };
    list.innerHTML = S.map((s, i) => `<button role="tab" aria-selected="${i === 0}" data-i="${i}"><i>${String(i + 1).padStart(2, '0')}</i><span>${s.name}<small>${s.sub}</small></span></button>`).join('');
    let token = 0;
    async function show(i) {
      const me = ++token, s = S[i];
      list.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', +b.dataset.i === i));
      $('#sim-title').textContent = 'scenario · ' + s.name.toLowerCase();
      $('#sim-tx').innerHTML = s.tx.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
      const li = ([l, v, st]) => `<li class="${st}"><span class="ic"></span><span>${l}</span><span class="r">${esc(v)}</span></li>`;
      $('#sim-risk').innerHTML = s.risk.map(li).join('');
      $('#sim-sec').innerHTML = s.sec.map(li).join('');
      $('#sim-pol').innerHTML = '';
      $('#sim-verdict').innerHTML = `<span class="vd wait">EVALUATING</span><span>Running both engines independently…</span>`;
      const items = [...document.querySelectorAll('#sim-risk li')].map((r, k) => [r, document.querySelectorAll('#sim-sec li')[k]]);
      for (const pair of items) { if (me !== token) return; pair.forEach(x => x && x.classList.add('in')); await sleep(170); }
      if (me !== token) return;
      $('#sim-pol').innerHTML = s.pol.length ? s.pol.map(p => `<span class="code-chip">${p}</span>`).join('') : '<span class="none">None</span>';
      const [c, t] = VD[s.v];
      $('#sim-verdict').innerHTML = `<span class="vd ${c}">${t}</span><span>${s.why}</span>`;
    }
    list.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(+b.dataset.i); });
    list.addEventListener('keydown', e => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
      e.preventDefault();
      const cur = +list.querySelector('[aria-selected="true"]').dataset.i, nx = (cur + (/Down|Right/.test(e.key) ? 1 : S.length - 1)) % S.length;
      show(nx); list.querySelector(`[data-i="${nx}"]`).focus();
    });
    let started = false;
    onView($('#sim-panel'), v => { if (v && !started) { started = true; show(0); } });
  })();

  /* ============================== architecture ============================== */
  (function arch() {
    const svg = $('#arch-viz');
    if (!svg) return;
    let s = '';
    s += box(390, 20, 220, 64, 'Autonomous Agent', 'decides and proposes');
    s += `<rect x="420" y="126" width="160" height="38" rx="19" class="v-box"/><text x="500" y="150" text-anchor="middle" class="v-s" style="fill:var(--fg-2)">API request · agent key</text>`;
    s += `<rect x="230" y="206" width="540" height="200" rx="10" class="v-box" style="fill:rgba(12,15,20,.7);stroke:rgba(255,255,255,.32)"/>`;
    s += `<text x="252" y="234" class="v-k">INTERCEPT API</text>`;
    s += box(256, 256, 156, 80, 'Risk Engine', 'financial limits', 'v-box-hi');
    s += box(422, 256, 156, 80, 'Transaction Firewall', 'security analysis', 'v-box-hi');
    s += box(588, 256, 156, 80, 'Policy Engine', 'versioned rules', 'v-box-hi');
    s += `<text x="500" y="384" text-anchor="middle" class="v-s">Evaluated independently · one decision</text>`;
    s += `<rect x="400" y="446" width="200" height="44" rx="6" class="v-box"/><text x="500" y="473" text-anchor="middle" class="v-t">Authorization decision</text>`;
    s += `<circle cx="345" cy="468" r="3.5" class="v-bad"/><text x="335" y="472" text-anchor="end" class="v-s">blocked</text>`;
    s += `<circle cx="655" cy="468" r="3.5" class="v-hold"/><text x="665" y="472" class="v-s">requires approval</text>`;
    s += `<path d="M400 468 H352" class="v-line"/><path d="M600 468 H648" class="v-line"/>`;
    s += box(390, 536, 220, 64, 'Chain', 'executed after enforcement');
    s += `<circle cx="520" cy="514" r="3.5" class="v-ok"/><text x="530" y="518" class="v-s">approved</text>`;
    s += box(20, 266, 170, 60, 'Autonomous Guardian', 'monitoring · planned');
    s += box(810, 266, 170, 60, 'Intercept Network', 'threat intel · future');
    s += `<path d="M190 296 H230" class="v-line-2" stroke-dasharray="4 4"/><path d="M810 296 H770" class="v-line-2" stroke-dasharray="4 4"/>`;
    s += `<path d="M105 326 V560 H388" class="v-line" stroke-dasharray="4 4"/><text x="114" y="552" class="v-s">can pause the agent</text>`;
    const spine = [[500, 84, 500, 124], [500, 164, 500, 204], [500, 406, 500, 444], [500, 490, 500, 534]];
    spine.forEach(([x1, y1, x2, y2]) => { s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="v-line-2"/>`; });
    s += `<path id="arch-flow" d="M500 84 V124 M500 164 V256 M500 336 V446 M500 490 V536" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="3 12" class="${reduce ? '' : 'arch-anim'}"/>`;
    svg.innerHTML = s + `<style>.arch-anim{animation:arch-d 1.6s linear infinite}@keyframes arch-d{to{stroke-dashoffset:-30}}</style>`;
  })();

  /* ============================== code ============================== */
  (function code() {
    const KW = /\b(import|from|const|let|export|async|function|await|return|switch|case|throw|new|default)\b/g;
    function hl(src, lang) {
      let h = esc(src);
      const keep = [];
      // placeholders use private-use characters so later passes (numbers, words) never match them
      const stash = (re, cls) => { h = h.replace(re, m => { keep.push(`<span class="${cls}">${m}</span>`); return String.fromCharCode(0xE000 + keep.length - 1); }); };
      stash(/(?<![:\w])\/\/[^\n]*/g, 'tk-c'); // not the "//" inside https://
      stash(/"(?:[^"\\\n]|\\.)*"/g, 'tk-s');
      if (lang === 'json') {
        h = h.replace(/([-])(\s*:)/g, (m, c, colon) => { const i = c.charCodeAt(0) - 0xE000; keep[i] = keep[i].replace('tk-s', 'tk-p'); return c + colon; });
        stash(/\b(true|false|null)\b/g, 'tk-k');
      } else {
        stash(KW, 'tk-k');
        stash(/\b([A-Za-z_]\w*)(?=\()/g, 'tk-f');
      }
      stash(/\b\d+(\.\d+)?\b/g, 'tk-n');
      return h.replace(/[-]/g, c => keep[c.charCodeAt(0) - 0xE000]);
    }
    document.querySelectorAll('.code-pane').forEach(p => { const c = p.querySelector('code'); c.innerHTML = hl(c.textContent, p.dataset.pane); });
    const tabs = document.querySelectorAll('.code-tabs [role=tab]');
    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => x.setAttribute('aria-selected', x === t));
      document.querySelectorAll('.code-pane').forEach(p => { p.hidden = p.dataset.pane !== t.dataset.tab; });
    }));
    const copy = document.querySelector('.code-copy');
    if (copy) copy.addEventListener('click', async () => {
      const pane = [...document.querySelectorAll('.code-pane')].find(p => !p.hidden);
      try { await navigator.clipboard.writeText(pane.textContent); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Press Ctrl+C'; const r = document.createRange(); r.selectNodeContents(pane); getSelection().removeAllRanges(); getSelection().addRange(r); }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    });
  })();

  /* ============================== subnav + reveal ============================== */
  (function nav() {
    const links = [...document.querySelectorAll('.subnav a')];
    const secs = links.map(a => document.querySelector(a.getAttribute('href')));
    const spy = () => {
      const y = scrollY + 200;
      let cur = -1;
      secs.forEach((s, i) => { if (s && s.offsetTop <= y) cur = i; });
      links.forEach((a, i) => a.classList.toggle('is-on', i === cur));
      const on = links[cur];
      if (on) { const bar = on.parentElement; const l = on.offsetLeft - bar.clientWidth / 2 + on.clientWidth / 2; if (Math.abs(bar.scrollLeft - l) > 40) bar.scrollTo({ left: l, behavior: reduce ? 'auto' : 'smooth' }); }
    };
    addEventListener('scroll', spy, { passive: true }); spy();

    if (reduce) return;
    const els = document.querySelectorAll('.pp-head, .mods, .mod-copy, .panel, .arch-frame, .use, .dev-copy');
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { threshold: 0.08 });
    els.forEach(el => { el.classList.add('sr-in'); io.observe(el); });
  })();
})();
