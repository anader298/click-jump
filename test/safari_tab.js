'use strict';
// Opens one background tab in the installed Safari. Needs no Safari settings.
// The page drives itself with scripted mouse events, so it proves Safari runs the
// client, but a physical Option+click is still a separate check.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/core/server');

const PAGE = `<!doctype html>
<html>
<head><title>Safari check</title></head>
<body>
  <h1 id="heading">Heading text</h1>
  <p id="para">A paragraph</p>
  <a id="link" href="other.html">A link</a>
</body>
</html>
`;
const lineOf = (needle) => PAGE.slice(0, PAGE.indexOf(needle)).split('\n').length;

// The policy blocks live reload in the runner itself, so a saved file reloads only the iframe.
const runner = (report, lines) => `<!doctype html><meta http-equiv="Content-Security-Policy" content="connect-src ${report}"><title>Click Jump test</title>
<p id="status">Click Jump test running. This tab is safe to close when it finishes.</p>
<iframe id="f" width="800" height="400"></iframe>
<script>
const R = ${JSON.stringify(report)}, L = ${JSON.stringify(lines)}, f = document.getElementById('f'), out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => { const end = Date.now() + 15000; while (Date.now() < end) { try { if (await fn()) return; } catch {} await sleep(80); } throw new Error('timed out: ' + label); };
const jumps = async () => (await fetch(R + '/jumps')).json();
const home = async () => {
  await fetch(R + '/reset');
  f.src = 'about:blank'; await sleep(60); f.src = 'index.html';
  await until(() => f.contentWindow.__clickJumpLoaded === true && f.contentDocument.getElementById('heading'), 'client loaded');
};
const fire = (el, type, alt) => { const b = el.getBoundingClientRect(); el.dispatchEvent(new f.contentWindow.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: f.contentWindow, altKey: alt, button: 0, clientX: b.left + 3, clientY: b.top + 3 })); };
const optionClick = (el) => { for (const t of ['mousemove', 'mousedown', 'mouseup', 'click']) fire(el, t, true); };
const check = async (name, fn) => { try { await fn(); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, why: String(e.message || e) }); } };
const $ = (id) => f.contentDocument.getElementById(id);
(async () => {
  await check('page loads with the client', home);
  await check('Option+hover shows the location label', async () => {
    await home();
    f.contentWindow.dispatchEvent(new f.contentWindow.KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true }));
    fire($('heading'), 'mousemove', true);
    await until(() => [...f.contentDocument.querySelectorAll('div')].some((d) => d.textContent.includes('index.html:') && d.getBoundingClientRect().width > 0), 'label visible');
    f.contentWindow.dispatchEvent(new f.contentWindow.KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
  });
  await check('a scripted Option+click is refused', async () => {
    await home(); optionClick($('heading'));
    await sleep(500);
    if ((await jumps()).length) throw new Error('a script triggered a jump');
  });
  await check('Safari can send a jump to the server', async () => {
    await home();
    const token = f.contentDocument.querySelector('script[data-cj-token]').getAttribute('data-cj-token');
    const loc = $('heading').getAttribute('data-cj');
    const r = await f.contentWindow.fetch(f.contentWindow.location.origin + '/__cj/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CJ-Token': token }, body: JSON.stringify({ loc }), keepalive: true, credentials: 'omit' });
    if (r.status !== 204) throw new Error('status ' + r.status);
    const j = await jumps(); if (!j.length || j[0].line !== L.heading) throw new Error('wrong jump');
  });
  await check('a normal click still follows the link', async () => {
    await home(); $('link').click();
    await until(() => /other\\.html/.test(f.contentWindow.location.href), 'navigation');
    if ((await jumps()).length) throw new Error('unexpected jump');
  });
  await check('saving the file reloads the page', async () => {
    await home(); await fetch(R + '/edit');
    await until(() => $('heading')?.textContent === 'Edited heading', 'reload');
    await fetch(R + '/restore');
    await until(() => $('heading')?.textContent === 'Heading text', 'reload back');
  });
  await fetch(R + '/done', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ua: navigator.userAgent, out }) });
  f.remove();
  document.getElementById('status').textContent = 'Click Jump test finished. You can close this tab.';
})();
</script>`;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-safari-tab-'));
  const index = path.join(root, 'index.html');
  fs.writeFileSync(index, PAGE);
  fs.writeFileSync(path.join(root, 'other.html'), '<!doctype html><h1 id="other">Other page</h1>\n');
  const jumps = [];
  const server = await startServer({ root, port: 0, watchIntervalMs: 60, onJump: (j) => jumps.push(j) });
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const reporter = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (process.env.CJ_DEBUG) console.error(new Date().toISOString().slice(14, 23), req.method, req.url);
    if (req.url === '/jumps') return res.end(JSON.stringify(jumps));
    if (req.url === '/reset') jumps.length = 0;
    if (req.url === '/edit') fs.writeFileSync(index, PAGE.replace('Heading text', 'Edited heading'));
    if (req.url === '/restore') fs.writeFileSync(index, PAGE);
    if (req.url === '/done') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { res.end('ok'); finish(JSON.parse(body)); });
      return undefined;
    }
    return res.end('ok');
  });
  await new Promise((resolve) => reporter.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, 'runner.html'), runner(`http://127.0.0.1:${reporter.address().port}`, { heading: lineOf('<h1'), link: lineOf('<a id') }));
  spawnSync('open', ['-g', '-a', 'Safari', `${server.origin}/runner.html`]);

  const result = await Promise.race([finished, new Promise((resolve) => setTimeout(() => resolve(null), Number(process.env.CJ_TAB_MS || 150000)))]);
  let failed = 0;
  let passed = 0;
  if (!result) {
    failed = 1;
    console.log('FAIL the Safari tab did not report back in time');
  } else {
    console.log(result.ua);
    for (const c of result.out) {
      if (c.ok) passed += 1; else failed += 1;
      console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.why ? `: ${c.why}` : ''}`);
    }
    const same = fs.readFileSync(index, 'utf8') === PAGE;
    if (same) passed += 1; else failed += 1;
    console.log(`${same ? 'ok  ' : 'FAIL'} source file is unchanged`);
  }
  reporter.close();
  reporter.closeAllConnections();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`safari tab: ${passed + failed} checks, ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
