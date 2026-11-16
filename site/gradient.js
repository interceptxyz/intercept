// Liquid gradient background: the exact fragment shader and uniforms the previous
// Framer landing used, run on a bare WebGL2 canvas (no framework).
(function () {
  const fragP = fetch('/liquid.frag').then(r => r.text());
  document.querySelectorAll('canvas[data-liquid]').forEach(init);
  function init(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) { canvas.classList.add('is-fallback'); return; }

  const COLORS = [[0, 0, 0], [14, 19, 27], [58, 66, 78], [86, 96, 110], [6, 8, 11], [6, 8, 11], [6, 8, 11], [6, 8, 11]];
  const U = { u_contrast: 1.2, u_distBias: 0, u_dither: 0.05, u_ditherMode: 0, u_exposure: 1, u_jellify: 0, u_loop: 0,
    u_saturation: 1, u_scale: 1.3, u_seed: 72, u_speed: 0.4, u_turbAmp: 0.5, u_turbFreq: 0.2, u_turbIter: 7, u_waveFreq: 2 };

  const head = '#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\n' +
    'uniform float u_time;\nuniform vec2 u_resolution;\nuniform float u_pixelRatio;\n' +
    'uniform vec4 u_colors[8];\nuniform int u_colors_length;\n' +
    Object.keys(U).map(k => 'uniform float ' + k + ';').join('\n') + '\n';
  const vert = '#version 300 es\nin vec2 a_pos;\nout vec2 v_uv;\nvoid main(){v_uv=a_pos*0.5+0.5;gl_Position=vec4(a_pos,0.0,1.0);}';

  function sh(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  fragP.then(frag => {
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vert));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, head + frag));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const L = n => gl.getUniformLocation(prog, n);
    gl.uniform4fv(L('u_colors'), new Float32Array(COLORS.flatMap(c => [c[0] / 255, c[1] / 255, c[2] / 255, 1])));
    gl.uniform1i(L('u_colors_length'), COLORS.length);
    for (const k in U) gl.uniform1f(L(k), U[k]);
    const uTime = L('u_time'), uRes = L('u_resolution'), uPr = L('u_pixelRatio');

    // the field is soft: render below device resolution and let CSS upscale
    const SCALE = canvas.dataset.liquid === "soft" ? 0.25 : 0.5;
    function resize() {
      const w = Math.max(1, Math.round(canvas.clientWidth * SCALE));
      const h = Math.max(1, Math.round(canvas.clientHeight * SCALE));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uPr, SCALE);
    }

    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true, start = performance.now(), raf = 0, frozen = 8;
    const draw = now => {
      resize();
      gl.uniform1f(uTime, reduce.matches ? frozen : (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const loop = now => { draw(now); raf = visible && !reduce.matches ? requestAnimationFrame(loop) : 0; };
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(loop);
    }).observe(canvas);
    addEventListener('resize', () => { if (!raf) draw(performance.now()); });
    reduce.addEventListener('change', () => { if (!raf) raf = requestAnimationFrame(loop); });
    raf = requestAnimationFrame(loop);
    canvas.classList.add('is-ready');
  }).catch(err => { console.warn('[ix-bg]', err); canvas.classList.add('is-fallback'); });
  }
})();
