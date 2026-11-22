'use strict';
// Runs in the installed Safari through Apple's safaridriver.
// One-time setup: sudo safaridriver --enable
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/core/server');

const DRIVER_PORT = 4799;
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const OPTION = '';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(60);
  }
  throw new Error(`timed out: ${label}`);
}

async function wd(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${DRIVER_PORT}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.value?.message || `WebDriver ${res.status}`);
  return json.value;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-safari-'));
  const index = path.join(root, 'index.html');
  fs.writeFileSync(index, PAGE);
  fs.writeFileSync(path.join(root, 'other.html'), '<!doctype html><h1 id="other">Other page</h1>\n');
  const jumps = [];
  const server = await startServer({ root, port: 0, watchIntervalMs: 60, onJump: (j) => jumps.push(j) });
  const driver = spawn('safaridriver', ['-p', String(DRIVER_PORT)], { stdio: 'ignore' });
  let sid;
  let passed = 0;
  let failed = 0;

  const run = async (name, fn) => {
    try {
      await fn();
      passed += 1;
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}: ${error.message}`);
    }
  };
  const js = (script, args = []) => wd('POST', `/session/${sid}/execute/sync`, { script, args });
  const find = async (id) => (await wd('POST', `/session/${sid}/element`, { using: 'css selector', value: `#${id}` }))[ELEMENT];
  const release = () => wd('DELETE', `/session/${sid}/actions`);
  const home = async () => {
    await wd('POST', `/session/${sid}/url`, { url: `${server.origin}/index.html` });
    await until(() => js('return window.__clickJumpLoaded === true'), 'client loaded');
    jumps.length = 0;
  };
  const pointer = (id, steps) => ({
    type: 'pointer',
    id: 'mouse',
    parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', duration: 60, origin: { [ELEMENT]: id }, x: 0, y: 0 }, ...steps],
  });
  const optionClick = async (id) => {
    await wd('POST', `/session/${sid}/actions`, {
      actions: [
        { type: 'key', id: 'keys', actions: [{ type: 'keyDown', value: OPTION }, { type: 'pause' }, { type: 'pause' }, { type: 'keyUp', value: OPTION }] },
        { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pause' }, { type: 'pointerMove', duration: 60, origin: { [ELEMENT]: id }, x: 0, y: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] },
      ],
    });
    await release();
  };

  try {
    await until(async () => {
      try { return (await wd('GET', '/status')).ready !== undefined; } catch { return false; }
    }, 'safaridriver started');
    sid = (await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })).sessionId;
    console.log(`Safari ${(await wd('GET', '/status')).message || ''}`.trim());

    await run('page loads with the client', home);
    await run('Option+hover shows the location label', async () => {
      await home();
      const heading = await find('heading');
      await wd('POST', `/session/${sid}/actions`, {
        actions: [
          { type: 'key', id: 'keys', actions: [{ type: 'keyDown', value: OPTION }, { type: 'pause' }] },
          { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pause' }, pointer(heading, []).actions[0]] },
        ],
      });
      await until(() => js("return Array.from(document.querySelectorAll('div')).some((d) => d.textContent.includes('index.html:') && d.getBoundingClientRect().width > 0)"), 'label visible');
      await release();
    });
    await run('Option+click jumps to the heading line', async () => {
      await home();
      await optionClick(await find('heading'));
      await until(() => jumps.length > 0, 'jump');
      assert.strictEqual(jumps[0].line, lineOf('<h1'));
    });
    await run('Option+click on a link jumps and stays on the page', async () => {
      await home();
      await optionClick(await find('link'));
      await until(() => jumps.length > 0, 'jump');
      assert.strictEqual(jumps[0].line, lineOf('<a id'));
      await sleep(300);
      assert.match(await wd('GET', `/session/${sid}/url`), /index\.html/);
    });
    await run('a normal click still follows the link', async () => {
      await home();
      await wd('POST', `/session/${sid}/element/${await find('link')}/click`, {});
      await until(async () => /other\.html/.test(await wd('GET', `/session/${sid}/url`)), 'navigation');
      assert.strictEqual(jumps.length, 0);
    });
    await run('saving the file reloads the page', async () => {
      await home();
      fs.writeFileSync(index, PAGE.replace('Heading text', 'Edited heading'));
      await until(() => js("return document.getElementById('heading')?.textContent === 'Edited heading'"), 'reload');
      fs.writeFileSync(index, PAGE);
      await until(() => js("return document.getElementById('heading')?.textContent === 'Heading text'"), 'reload back');
    });
    await run('source file is unchanged', async () => {
      assert.strictEqual(fs.readFileSync(index, 'utf8'), PAGE);
    });
  } catch (error) {
    failed += 1;
    console.log(`FAIL setup: ${error.message}`);
  } finally {
    if (sid) await wd('DELETE', `/session/${sid}`).catch(() => {});
    driver.kill();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`safari: ${passed + failed} checks, ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
