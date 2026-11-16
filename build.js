// Build: patched copy of the Waitlst Framer page.
// - LiquidGradient palette swapped to the reference image tones
// - Nav Bar hidden (CSS, node kept for hydration)
// - editor bar / analytics removed
const fs = require('fs');
const path = require('path');
const CDN = 'https://framerusercontent.com/sites/6EPXBCxutmi0vRjpXsPD26/';
const PAGE = 'kCC2HP6fAZLv21XnLj0YjjgXWz0LgRDFOZ51wFsoIEY.DoA3ZiBl.mjs';
const MAIN = 'script_main.Cpgw1JED.mjs';
const X_URL = 'https://x.com/interdotxyz';
const root = __dirname;
const out = path.join(root, 'public');
for (const d of ['m', 'img', 'index.html', 'favicon.ico', 'favicon-32.png', 'favicon-180.png', 'favicon-512.png', 'og.png']) fs.rmSync(path.join(out, d), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'm'), { recursive: true });
fs.mkdirSync(path.join(out, 'img'), { recursive: true });

const absImports = (src, keepLocal = []) =>
  src.replace(/(["'`])\.\/([A-Za-z0-9_.\-]+\.mjs)\1/g, (m, q, f) =>
    keepLocal.includes(f) ? m : q + CDN + f + q);

// page module: new palette
let page = fs.readFileSync(path.join(root, 'mods', PAGE), 'utf8');
const oldPal = /u_colors:\{type:`array`,value:\[[^\]]*\]/;
if (!oldPal.test(page)) throw new Error('palette not found');
const pal = ['rgb(0, 0, 0)', 'rgb(14, 19, 27)', 'rgb(118, 131, 148)', 'rgb(160, 172, 187)',
  'rgb(6, 8, 11)', 'rgb(6, 8, 11)', 'rgb(6, 8, 11)', 'rgb(6, 8, 11)'];
page = page.replace(oldPal, 'u_colors:{type:`array`,value:[' + pal.map(c => '`' + c + '`').join(',') + ']');
page = page.replace(/\/\/# sourceMappingURL=.*$/m, '').split('https://x.com/j_kyorov/').join(X_URL);
const META = 'augiA20Il.dHryePZ6.mjs', SHARED = 'fVxnimdqP.DGsdylDj.mjs';
const LOCAL = [PAGE, MAIN, META, SHARED];
fs.writeFileSync(path.join(out, 'm', PAGE), absImports(page, LOCAL));
// page metadata module: Framer resets document.title from it on hydration
for (const f of [META, SHARED]) {
  let src = fs.readFileSync(path.join(root, 'mods', f), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '');
  src = src.split('title:`Waitlst - Framer Template`').join('title:`Intercept`');
  src = src.split('https://framerusercontent.com/assets/Quc58qzchA2GTEEHxRxjhLUin3k.jpg').join('https://www.intercepting.xyz/og.png');
  fs.writeFileSync(path.join(out, 'm', f), absImports(src, LOCAL));
}

let main = fs.readFileSync(path.join(root, 'mods', MAIN), 'utf8');
main = main.replace(/\/\/# sourceMappingURL=.*$/m, '').split('https://x.com/j_kyorov/').join(X_URL);
// footer "404" link -> Docs
const DOCS_URL = 'https://docs.intercepting.xyz';
const footOld = /href:\{webPageId:`hFE5qvhtQ`\}(,motionChild:!0,nodeId:`Aaxy57cOZ`,)openInNewTab:!1(.{0,200}?"data-styles-preset":`ro7OPezbn`,children:)`404`/;
if (!footOld.test(main)) throw new Error('footer 404 link not found in bundle');
main = main.replace(footOld, 'href:`' + DOCS_URL + '`$1openInNewTab:!1$2`Docs`');
fs.writeFileSync(path.join(out, 'm', MAIN), absImports(main, LOCAL));

// HTML
let html = fs.readFileSync(path.join(root, 'orig.html'), 'utf8');
const F = './Waitlst - Framer Template_files/';
html = html.split(F + MAIN).join('/m/' + MAIN);
html = html.replace(/(<a class="framer-text framer-styles-preset-1wicq5s" data-styles-preset="ro7OPezbn" href=")https:\/\/waitlst\.framer\.website\/404(">)404</, '$1' + DOCS_URL + '$2Docs<');
if (!html.includes(DOCS_URL)) throw new Error('footer 404 link not found in HTML');
for (const f of LOCAL) html = html.split(CDN + f).join('/m/' + f); // modulepreload
html = html.replace(/<script async="" src="\.\/Waitlst - Framer Template_files\/script"[^>]*><\/script>/, '');
html = html.replace(/<iframe id="__framer-editorbar"[\s\S]*?<\/iframe>/, '');
// SSR palette also lives in the HTML?  (canvas only - nothing to patch)
for (const f of fs.readdirSync(path.join(root, 'orig_files'))) {
  if (!f.endsWith('.png')) continue;
  fs.copyFileSync(path.join(root, 'orig_files', f), path.join(out, 'img', f));
}
html = html.split(F).join('/img/');
html = html.replace('</head>',
  '<style>.framer-s3vmbm,#__framer-editorbar,#__framer-badge-container,.framer-1yt4etl-container,' +
  '.framer-11va69s-container,.framer-4oo0p9-container{display:none!important}' +
  // blur-in on appear: background first, then hero blocks staggered
  '@keyframes ix-blur-in{from{filter:blur(24px);opacity:0;transform:translateY(12px)}to{filter:blur(0);opacity:1;transform:none}}' +
  '@keyframes ix-bg-in{from{filter:blur(60px);opacity:0}to{filter:blur(0);opacity:1}}' +
  '.framer-7ikklo-container{animation:ix-bg-in 1.6s cubic-bezier(.22,1,.36,1) backwards}' +
  '.framer-ibk2ts{animation:ix-blur-in 1.1s cubic-bezier(.22,1,.36,1) .25s backwards}' +
  '.framer-1f1vwc3{animation:ix-blur-in 1.2s cubic-bezier(.22,1,.36,1) .4s backwards}' +
  '.framer-mpqv2o{animation:ix-blur-in 1.1s cubic-bezier(.22,1,.36,1) .55s backwards}' +
  '.framer-178hwmg{animation:ix-blur-in 1.1s cubic-bezier(.22,1,.36,1) .7s backwards}' +
  '.framer-1frj0wc{animation:ix-blur-in 1.1s cubic-bezier(.22,1,.36,1) .85s backwards}' +
  '@media (prefers-reduced-motion:reduce){.framer-7ikklo-container,.framer-ibk2ts,.framer-1f1vwc3,.framer-mpqv2o,.framer-178hwmg,.framer-1frj0wc{animation:none}}' +
  '</style></head>');
html = html.split('https://x.com/j_kyorov/').join(X_URL);
const TITLE = 'Intercept';
html = html.replace(/<title>[^<]*<\/title>/, '<title>' + TITLE + '</title>');
html = html.split('content="Waitlst - Framer Template"').join('content="' + TITLE + '"');
// favicon: user logo
html = html.replace(/<link href="[^"]*" rel="icon"[^>]*>/g, '');
html = html.replace(/<link[^>]*rel="apple-touch-icon"[^>]*>/g, '');
html = html.replace('</head>',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">' +
  '<link rel="icon" type="image/png" sizes="512x512" href="/favicon-512.png">' +
  '<link rel="apple-touch-icon" sizes="180x180" href="/favicon-180.png"></head>');
for (const s of [32, 180, 512]) fs.copyFileSync(path.join(root, `favicon-${s}.png`), path.join(out, `favicon-${s}.png`));
fs.copyFileSync(path.join(root, 'favicon-32.png'), path.join(out, 'favicon.ico'));
// embed image (make-og.js)
const OG = 'https://www.intercepting.xyz/og.png';
html = html.split('https://framerusercontent.com/assets/Quc58qzchA2GTEEHxRxjhLUin3k.jpg').join(OG);
html = html.replace('</head>', '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"></head>');
fs.copyFileSync(path.join(root, 'og.png'), path.join(out, 'og.png'));
html = html.replace(/<!-- saved from url=[^>]*-->\s*/, '');
html = html.split('https://waitlst.framer.website/').join('https://www.intercepting.xyz/');
// Docs button, fixed bottom-centre (outside Framer's #main so hydration leaves it alone)
html = html.replace('</head>', '<style>' +
  '.ix-docs{position:fixed;left:50%;bottom:28px;z-index:20;transform:translateX(-50%);display:inline-flex;align-items:center;gap:8px;' +
  'height:40px;padding:0 18px 0 16px;border-radius:100px;border:1px solid rgba(255,255,255,.12);' +
  'background:linear-gradient(rgba(255,255,255,.02),rgba(255,255,255,.1));-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);' +
  'color:#fff;font:500 13px/1 Poppins,"Poppins Placeholder",sans-serif;text-decoration:none;letter-spacing:0;' +
  'box-shadow:0 8px 30px rgba(0,0,0,.45);transition:border-color .2s,background .2s;animation:ix-blur-in 1.1s cubic-bezier(.22,1,.36,1) 1s backwards}' +
  '.ix-docs:hover{border-color:rgba(255,255,255,.28);background:linear-gradient(rgba(255,255,255,.05),rgba(255,255,255,.16))}' +
  '.ix-docs svg{width:15px;height:15px;opacity:.85}.ix-docs .ix-arr{transition:transform .2s}.ix-docs:hover .ix-arr{transform:translateX(2px)}' +
  '.ix-docs:focus-visible{outline:2px solid #a0acbb;outline-offset:3px}' +
  '@keyframes ix-docs-in{from{opacity:0}to{opacity:1}}' +
  '@media (prefers-reduced-motion:reduce){.ix-docs{animation:none}}' +
  '</style></head>');
html = html.replace('</body>', '<a class="ix-docs" href="' + DOCS_URL + '">' +
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13"/></svg>' +
  'Docs<svg class="ix-arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></a></body>');
const left = html.match(/\/img\/(?![A-Za-z0-9]+\.png)[^"'\s)]*/g);
if (left) console.warn('unresolved local refs:', [...new Set(left)]);
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('built', fs.readdirSync(path.join(out, 'm')));
