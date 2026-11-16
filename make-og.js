// Builds og.png (1200x630): mark + wordmark, headline, tagline and domain on the site's dark palette.
// Previous version (logo on stripes) is kept as og-old-stripes.png.
const puppeteer = require('C:/Users/Utilisateur/aeye/node_modules/puppeteer-core');
const fs = require('fs');
const mark = fs.readFileSync('C:/Users/Utilisateur/intercept-docs/assets/mark.png').toString('base64');

const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Poppins:wght@400;500&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; }
  .og { position: relative; width: 1200px; height: 630px; overflow: hidden; background: #050608; color: #eef1f6; font-family: Inter, sans-serif; }
  .bg { position: absolute; inset: 0;
    background:
      radial-gradient(900px 520px at 88% 112%, rgba(54, 74, 112, .55), transparent 62%),
      radial-gradient(700px 420px at 105% 20%, rgba(32, 44, 70, .55), transparent 60%),
      radial-gradient(600px 400px at -5% -10%, rgba(40, 48, 62, .45), transparent 60%); }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size: 80px 80px; mask-image: linear-gradient(90deg, transparent 0%, #000 55%, #000 100%); }
  .in { position: absolute; inset: 80px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 16px; font: 500 34px/1 Poppins, sans-serif; letter-spacing: -.02em; }
  .brand img { width: 44px; height: 44px; }
  h1 { margin: auto 0 0; font: 500 66px/1.06 Poppins, sans-serif; letter-spacing: -.035em; max-width: 900px; }
  .tag { margin-top: 26px; font-size: 26px; color: #9aa4b5; letter-spacing: -.005em; }
  .foot { margin-top: 44px; display: flex; justify-content: space-between; align-items: center; font-size: 20px; color: #6f7a8c; border-top: 1px solid rgba(255,255,255,.1); padding-top: 22px; }
  .foot b { color: #c9d1de; font-weight: 500; }
</style></head><body>
<div class="og"><div class="bg"></div><div class="grid"></div>
  <div class="in">
    <div class="brand"><img src="data:image/png;base64,${mark}" alt="">Intercept</div>
    <h1>The risk and security API for autonomous agents.</h1>
    <div class="tag">Agents decide. Intercept enforces.</div>
    <div class="foot"><b>intercepting.xyz</b><span>Configure · Connect · Protect</span></div>
  </div>
</div></body></html>`;

(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: 'networkidle0' });
  await p.evaluate(() => document.fonts.ready);
  await (await p.$('.og')).screenshot({ path: 'C:/Users/Utilisateur/interecept/og.png' });
  await b.close();
  console.log('og.png written');
})();
