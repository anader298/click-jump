'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { parseArgs } = require('../src/cli/args');
const { editorArgv, splitCommand, browserArgv, windowsCmdSpawn } = require('../src/cli/launch');
const { resolveTarget, charColumn } = require('../src/cli/main');
const { tmpDir, request, waitFor } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'click-jump.js');
// Tests must never open a real browser or editor on the machine running them.
const SAFE_ENV = { ...process.env, CLICK_JUMP_NO_OPEN: '1', CLICK_JUMP_EDITOR: '' };

function run(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: SAFE_ENV, timeout: 15000 });
}

function serve(t, args, cwd) {
  const child = spawn(process.execPath, [BIN, '--no-open', ...args], { cwd, env: SAFE_ENV });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  t.after(() => { child.kill('SIGKILL'); });
  return { child, exited, output: () => out, errors: () => err, url: async () => {
    const m = await waitFor(() => /Preview: (http:\S+)/.exec(out), 8000, `preview URL (stderr: ${err})`);
    return new URL(m[1]);
  } };
}

async function jump(url, loc) {
  const page = (await request(url.port, { path: url.pathname })).body.toString();
  const token = /data-cj-token="([^"]+)"/.exec(page)[1];
  return request(url.port, {
    method: 'POST', path: '/__cj/open',
    headers: { Origin: url.origin, 'X-CJ-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loc }),
  });
}

/** An "editor" that records its argv as JSON lines. */
function fakeEditor(dir) {
  const log = path.join(dir, 'editor.log');
  const script = path.join(dir, 'fake-editor.js');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  return { cmd: `"${process.execPath}" "${script}" {file} {line} {col}`, log };
}

test('args: defaults', () => {
  const o = parseArgs([]);
  assert.strictEqual(o.target, null);
  assert.strictEqual(o.browser, 'default');
  assert.strictEqual(o.open, true);
});
test('args: every flag', () => {
  const o = parseArgs(['site', '--safari', '--terminal', '--port', '8123', '--editor', 'zed', '--no-open']);
  assert.deepStrictEqual([o.target, o.browser, o.terminal, o.port, o.editor, o.open], ['site', 'safari', true, 8123, 'zed', false]);
});
test('args: --browser forms', () => {
  assert.strictEqual(parseArgs(['--browser', 'firefox']).browser, 'firefox');
  assert.strictEqual(parseArgs(['--browser=Google Chrome Canary']).browser, 'Google Chrome Canary');
  const o = parseArgs(['--browser', 'mysite']);
  assert.deepStrictEqual([o.browser, o.target], ['default', 'mysite']);
});
test('args: errors', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['--port', 'abc']), /--port/);
  assert.throws(() => parseArgs(['--port', '70000']), /--port/);
  assert.throws(() => parseArgs(['--port']), /needs a value/);
  assert.throws(() => parseArgs(['a', 'b']), /Only one/);
});
test('args: -- allows a file named like a flag', () => {
  assert.strictEqual(parseArgs(['--', '--safari.html']).target, '--safari.html');
});
test('args: a folder named setup still works after another path', () => {
  assert.strictEqual(parseArgs(['./setup']).target, './setup');
  assert.strictEqual(parseArgs(['setup']).command, 'setup');
});

test('editor argv keeps a hostile filename as one argument', () => {
  const file = '/tmp/a b; rm -rf ~ $(whoami) `id` "q".html';
  assert.deepStrictEqual(editorArgv('code', { file, line: 3, col: 7 }), ['code', '--reuse-window', '--goto', `${file}:3:7`]);
  assert.deepStrictEqual(editorArgv('mate -l {line} {file}', { file, line: 3, col: 7 }), ['mate', '-l', '3', file]);
  assert.deepStrictEqual(editorArgv('zed', { file, line: 3, col: 7 }), ['zed', `${file}:3:7`]);
});
test('splitCommand honours quotes', () => {
  assert.deepStrictEqual(splitCommand('"/Apps/My Editor/bin" --x \'a b\' ""'), ['/Apps/My Editor/bin', '--x', 'a b', '']);
  assert.throws(() => splitCommand('"oops'), /Unclosed/);
});
test('Windows: cmd metacharacters in a path refuse to launch', () => {
  for (const bad of ['C:\\a&calc.html', 'C:\\%PATH%.html', 'C:\\a^b.html', 'C:\\a|b.html', 'C:\\a"b.html', 'C:\\a!b.html']) {
    assert.throws(() => windowsCmdSpawn(['code.cmd', '--goto', bad]), /cmd\.exe/);
  }
  const ok = windowsCmdSpawn(['C:\\VS Code\\bin\\code.cmd', '--goto', 'C:\\my site\\index.html:1:1']);
  assert.deepStrictEqual(ok.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(ok.args[3].includes('"C:\\my site\\index.html:1:1"'));
});
test('browser argv per platform, without a shell', () => {
  const url = 'http://127.0.0.1:5757/';
  assert.deepStrictEqual(browserArgv('safari', url, 'darwin'), ['open', '-a', 'Safari', url]);
  assert.deepStrictEqual(browserArgv('default', url, 'darwin'), ['open', url]);
  assert.deepStrictEqual(browserArgv('chrome', url, 'darwin'), ['open', '-a', 'Google Chrome', url]);
  assert.deepStrictEqual(browserArgv('default', url, 'linux'), ['xdg-open', url]);
  assert.deepStrictEqual(browserArgv('firefox', url, 'linux', () => true), ['firefox', url]);
  assert.deepStrictEqual(browserArgv('default', url, 'win32'), ['rundll32', 'url.dll,FileProtocolHandler', url]);
  assert.throws(() => browserArgv('safari', url, 'linux'), /macOS/);
  assert.throws(() => browserArgv('safari', url, 'win32'), /macOS/);
  assert.throws(() => browserArgv('nope & calc', url, 'win32'), /Unknown browser/);
});

test('resolveTarget: index, htm, single page, file, errors', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'b.html'), 'x');
  fs.writeFileSync(path.join(d, 'a.html'), 'x');
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  assert.strictEqual(resolveTarget(null, d).page, path.join(d, 'a.html'));
  assert.strictEqual(resolveTarget(null, d).others, 1);
  fs.writeFileSync(path.join(d, 'index.htm'), 'x');
  assert.strictEqual(resolveTarget(null, d).page, path.join(d, 'index.htm'));
  fs.writeFileSync(path.join(d, 'index.html'), 'x');
  assert.strictEqual(resolveTarget(null, d).page, path.join(d, 'index.html'));
  assert.strictEqual(resolveTarget('b.html', d).root, d);
  assert.throws(() => resolveTarget('notes.txt', d), /Not an HTML/);
  assert.throws(() => resolveTarget('missing', d), /Not found/);
  const empty = tmpDir();
  assert.throws(() => resolveTarget(null, empty), /No HTML/);
});

test('charColumn converts UTF-16 columns to characters for Vim', () => {
  const d = tmpDir();
  const f = path.join(d, 'a.html');
  fs.writeFileSync(f, 'x\r\n<p>\ud83c\udf70<b>y</b></p>\n');
  assert.strictEqual(charColumn(f, 2, 6), 5);
});

test('--help and --version', () => {
  const h = run(['--help']);
  assert.strictEqual(h.status, 0);
  for (const flag of ['--safari', '--browser', '--terminal', '--editor', '--port']) assert.ok(h.stdout.includes(flag), flag);
  assert.strictEqual(run(['--version']).stdout.trim(), require('../package.json').version);
});

test('setup is read-only and reports', () => {
  const d = tmpDir();
  const r = run(['setup'], d);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('read-only'));
  assert.deepStrictEqual(fs.readdirSync(d), []);
});

test('bad usage exits non-zero with a message', () => {
  const d = tmpDir();
  assert.strictEqual(run(['--wat'], d).status, 2);
  const missing = run(['nope.html'], d);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /Not found/);
  const empty = run([], d);
  assert.strictEqual(empty.status, 1);
  assert.match(empty.stderr, /No HTML file/);
});

test('no arguments: finds index.html, serves it, stops on SIGINT', async (t) => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'index.html'), '<h1>hello</h1>');
  const s = serve(t, ['--editor', 'true {file}'], d);
  const url = await s.url();
  assert.strictEqual(url.hostname, '127.0.0.1');
  assert.ok((await request(url.port, { path: url.pathname })).body.toString().includes('<h1 data-cj="index.html:1:1"'));
  s.child.kill('SIGINT');
  assert.strictEqual((await s.exited).code, 0);
  await assert.rejects(request(url.port, { path: '/' }));
});

test('--port is honoured; a busy port is a clear error', async (t) => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'index.html'), '<p>x</p>');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  t.after(() => blocker.close());
  const r = run(['--no-open', '--port', String(port)], d);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /in use/);
});

test('hostile filename reaches the editor as one argument and runs nothing', { skip: process.platform === 'win32' }, async (t) => {
  const d = tmpDir();
  const name = `we"ird $(touch PWNED) ; 'x' caf\u00e9 \ud83c\udf70.html`;
  fs.writeFileSync(path.join(d, name), '<p>one</p>\n<b>two</b>\n');
  const ed = fakeEditor(d);
  const s = serve(t, [name, '--editor', ed.cmd], d);
  const url = await s.url();
  assert.strictEqual((await jump(url, `${encodeURIComponent(name)}:2:1`)).status, 204);
  const line = await waitFor(() => fs.existsSync(ed.log) && fs.readFileSync(ed.log, 'utf8').trim(), 5000, 'editor log');
  assert.deepStrictEqual(JSON.parse(line), [path.join(d, name), '2', '1']);
  assert.ok(!fs.existsSync(path.join(d, 'PWNED')));
});

test('file argument in a subfolder with spaces', async (t) => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'my site'));
  fs.writeFileSync(path.join(d, 'my site', 'about us.html'), '<p>x</p>');
  const s = serve(t, ['my site/about us.html', '--editor', 'true {file}'], d);
  const url = await s.url();
  assert.ok(url.pathname.endsWith('/about%20us.html'));
  assert.strictEqual((await request(url.port, { path: url.pathname })).status, 200);
});

test('a missing editor does not crash the server', async (t) => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'index.html'), '<p>x</p>');
  const s = serve(t, ['--editor', 'definitely-not-an-editor-xyz'], d);
  const url = await s.url();
  assert.strictEqual((await jump(url, 'index.html:1:1')).status, 500);
  assert.strictEqual((await request(url.port, { path: '/' })).status, 200);
});

test('package has no runtime dependencies', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.dependencies, undefined);
});
