'use strict';
// Real browser engines, headless. Playwright's WebKit is NOT Safari.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startServer } = require('../src/core/server');
const { tmpDir, waitFor } = require('./helpers');

const PAGE = `<!doctype html>
<html>
<head><title>E2E</title><base href="/"></head>
<body>
  <h1 id="heading">Heading text</h1>
  <p id="para">Some
    <strong id="nested"><em id="deep">deep text</em></strong>
  </p>
  <a id="link" href="other.html">A link</a>
  <a id="dl" href="file.zip">Plain file link</a>
  <a id="dlattr" href="file.zip" download>Download attr</a>
  <a id="blank" href="other.html" target="_blank">New tab</a>
  <img id="pic"
       src="pic.svg" alt="pic" width="60" height="40">
  <button id="btn" onclick="window.clicks = (window.clicks || 0) + 1">Button</button>
  <label id="lab"><input id="check" type="checkbox"> Tick</label>
  <form id="form" action="other.html"><button id="submit">Send</button></form>
  <details id="det"><summary id="sum">More</summary>Hidden</details>
  <svg id="svg" width="40" height="40"><circle id="circle" cx="20" cy="20" r="18"/></svg>
  <div id="host"></div>
  <div id="dyn"></div>
  <input id="field" value="text">
  <script>
    window.seen = [];
    for (const type of ['mousedown', 'click']) {
      document.addEventListener(type, (e) => window.seen.push(type + ':' + e.target.id), true);
    }
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<span id="inner">shadow</span>';
    document.getElementById('dyn').innerHTML = '<span id="made">made by script</span>';
  </script>
</body>
</html>
`;

const lineOf = (needle) => PAGE.slice(0, PAGE.indexOf(needle)).split('\n').length;

// CJ_REAL_CHROME=1 runs the same checks in the installed Google Chrome, with a throwaway profile.
const engines = process.env.CJ_REAL_CHROME
  ? { 'google-chrome': { launch: (options) => chromium.launch({ ...options, channel: 'chrome' }) } }
  : { chromium, firefox, webkit };

for (const [name, engine] of Object.entries(engines)) {
  test(name, async (t) => {
    const root = tmpDir('cj-e2e-');
    fs.writeFileSync(path.join(root, 'index.html'), PAGE);
    fs.writeFileSync(path.join(root, 'other.html'), '<!doctype html><h1 id="other">Other page</h1>\n');
    fs.writeFileSync(path.join(root, 'file.zip'), 'zipdata');
    fs.writeFileSync(path.join(root, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="teal"/></svg>');
    const original = fs.readFileSync(path.join(root, 'index.html'));
    const jumps = [];
    const server = await startServer({ root, port: 0, watchIntervalMs: 60, onJump: (j) => jumps.push(j) });
    // Registered before launch so a missing browser fails the run instead of hanging on the open server.
    let browser;
    t.after(async () => {
      await browser?.close();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1000, height: 1100 } });
    const page = await context.newPage();
    const downloads = [];
    context.on('page', (p) => p.on('download', (d) => downloads.push(d)));
    page.on('download', (d) => downloads.push(d));
    const home = `${server.origin}/index.html`;

    const fresh = async () => {
      if (page.url() !== home) await page.goto(home);
      else await page.reload();
      await page.waitForFunction(() => window.__clickJumpLoaded === true);
      jumps.length = 0;
    };

    async function altClick(sel, expectedNeedle, label) {
      await fresh();
      await page.click(sel, { modifiers: ['Alt'], force: true });
      await waitFor(() => jumps.length > 0, 3000, `jump for ${label}`);
      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(jumps.length, 1, `${label}: one jump`);
      assert.strictEqual(jumps[0].line, lineOf(expectedNeedle), `${label}: line`);
      assert.strictEqual(page.url(), home, `${label}: did not navigate`);
    }

    for (const [label, sel, needle] of [
      ['text', '#heading', 'id="heading"'],
      ['paragraph', '#para', 'id="para"'],
      ['nested inner element', '#deep', 'id="deep"'],
      ['link', '#link', 'id="link"'],
      ['image on a multi-line tag', '#pic', 'id="pic"'],
      ['button', '#btn', 'id="btn"'],
      ['label', '#lab', 'id="lab"'],
      ['submit button', '#submit', 'id="submit"'],
      ['summary', '#sum', 'id="sum"'],
      ['svg shape', '#circle', 'id="circle"'],
      ['shadow DOM child resolves to host', '#inner', 'id="host"'],
      ['script-made element resolves to parent', '#made', 'id="dyn"'],
      ['text input', '#field', 'id="field"'],
    ]) {
      await t.test(`Alt+click ${label}`, () => altClick(sel, needle, label));
    }

    await t.test('Alt+click on a link does not download', async () => {
      for (const [sel, needle] of [['#dl', 'id="dl"'], ['#dlattr', 'id="dlattr"']]) {
        downloads.length = 0;
        await altClick(sel, needle, sel);
        await new Promise((r) => setTimeout(r, 250));
        assert.strictEqual(downloads.length, 0, `${sel} downloaded`);
      }
    });

    await t.test('Alt+click target=_blank opens no tab', async () => {
      await altClick('#blank', 'id="blank"', 'blank');
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(context.pages().length, 1);
    });

    await t.test('Alt+click does not fire the page handlers', async () => {
      await altClick('#btn', 'id="btn"', 'button');
      assert.strictEqual(await page.evaluate(() => window.clicks || 0), 0);
      assert.deepStrictEqual(await page.evaluate(() => window.seen), []);
    });

    await t.test('Alt+click leaves checkbox, form and details alone', async () => {
      await altClick('#lab', 'id="lab"', 'label');
      assert.strictEqual(await page.isChecked('#check'), false);
      await altClick('#sum', 'id="sum"', 'summary');
      assert.strictEqual(await page.evaluate(() => document.getElementById('det').open), false);
    });

    await t.test('Alt+click does not select text', async () => {
      await altClick('#para', 'id="para"', 'para');
      assert.strictEqual(await page.evaluate(() => String(getSelection())), '');
    });

    await t.test('normal click on a button still works', async () => {
      await fresh();
      await page.click('#btn');
      assert.strictEqual(await page.evaluate(() => window.clicks), 1);
      assert.strictEqual(jumps.length, 0);
    });

    await t.test('normal click on a checkbox still works', async () => {
      await fresh();
      await page.click('#check');
      assert.strictEqual(await page.isChecked('#check'), true);
    });

    await t.test('normal click on a link still navigates', async () => {
      await fresh();
      await Promise.all([page.waitForURL('**/other.html'), page.click('#link')]);
      assert.strictEqual(jumps.length, 0);
    });

    await t.test('a normal click right after an Alt+click is not swallowed', async () => {
      await fresh();
      await page.click('#heading', { modifiers: ['Alt'] });
      await waitFor(() => jumps.length === 1);
      await page.click('#btn');
      assert.strictEqual(await page.evaluate(() => window.clicks), 1);
    });

    await t.test('releasing Alt mid-press still suppresses the click', async () => {
      await fresh();
      const box = await page.locator('#link').boundingBox();
      await page.mouse.move(box.x + 5, box.y + 5);
      await page.keyboard.down('Alt');
      await page.mouse.down();
      await page.keyboard.up('Alt');
      await page.mouse.up();
      await waitFor(() => jumps.length === 1);
      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(page.url(), home);
    });

    await t.test('hover outline shows with Alt and clears on release', async () => {
      await fresh();
      const visible = () => page.evaluate(() => {
        const o = document.querySelector('[data-cj-overlay]');
        return !!o && getComputedStyle(o).display !== 'none';
      });
      await page.keyboard.down('Alt');
      await page.hover('#heading');
      await waitFor(visible, 2000, 'outline');
      await page.keyboard.up('Alt');
      await waitFor(async () => !(await visible()), 2000, 'outline clear');
    });

    await t.test('stuck Alt clears on window blur', async () => {
      await fresh();
      const visible = () => page.evaluate(() => {
        const o = document.querySelector('[data-cj-overlay]');
        return !!o && getComputedStyle(o).display !== 'none';
      });
      await page.keyboard.down('Alt');
      await page.hover('#heading');
      await waitFor(visible, 2000, 'outline');
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await waitFor(async () => !(await visible()), 2000, 'outline clear after blur');
      await page.keyboard.up('Alt');
    });

    await t.test('saving the file reloads the page', async () => {
      await fresh();
      await page.evaluate(() => { window.marker = 1; });
      const edited = PAGE.replace('Heading text', 'Edited heading');
      fs.writeFileSync(path.join(root, 'index.html'), edited);
      await page.waitForFunction(() => document.getElementById('heading')?.textContent === 'Edited heading', null, { timeout: 8000 });
      assert.strictEqual(await page.evaluate(() => window.marker), undefined);
      fs.writeFileSync(path.join(root, 'index.html'), original);
      await page.waitForFunction(() => document.getElementById('heading')?.textContent === 'Heading text', null, { timeout: 8000 });
    });

    await t.test('source file unchanged by byte comparison', () => {
      const now = fs.readFileSync(path.join(root, 'index.html'));
      assert.strictEqual(crypto.createHash('sha256').update(now).digest('hex'), crypto.createHash('sha256').update(original).digest('hex'));
    });

    await t.test('a cross-origin page cannot trigger a jump', async () => {
      await fresh();
      const other = await startServer({ root, port: 0 });
      try {
        const attacker = await context.newPage();
        await attacker.goto(`${other.origin}/other.html`);
        const result = await attacker.evaluate(async (target) => {
          try {
            const r = await fetch(`${target}/__cj/open`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CJ-Token': 'guess' }, body: '{"loc":"index.html:1:1"}',
            });
            return `status ${r.status}`;
          } catch { return 'blocked'; }
        }, server.origin);
        await attacker.close();
        assert.strictEqual(result, 'blocked');
        assert.strictEqual(jumps.length, 0);
      } finally {
        await other.close();
      }
    });
  });
}
