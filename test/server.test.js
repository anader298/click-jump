'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { startServer, MAX_BODY } = require('../src/core/server');
const { tmpDir, request, postJump, waitFor } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const symlinks = process.platform !== 'win32';

async function site(t, opts = {}) {
  const base = tmpDir();
  const root = path.join(base, 'site');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>\n<html><body>\n<h1 id="t">Hi</h1>\n</body></html>\n');
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), '<p>sub</p>');
  fs.writeFileSync(path.join(root, 'sub', 'my page.html'), '<p>spaced</p>');
  fs.writeFileSync(path.join(root, 'style.css'), 'p{color:red}');
  fs.writeFileSync(path.join(root, 'app.js'), 'var a=1;');
  fs.writeFileSync(path.join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]));
  fs.writeFileSync(path.join(root, 'data.bin'), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'x');
  fs.writeFileSync(path.join(base, 'outside.html'), '<p>outside</p>');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside secret');
  const jumps = [];
  const server = await startServer({ root, port: 0, watchIntervalMs: 40, onJump: (j) => jumps.push(j), ...opts });
  t.after(async () => { await server.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { server, root, base, jumps, port: server.port };
}

test('binds to 127.0.0.1 only', async (t) => {
  const { server } = await site(t);
  assert.strictEqual(new URL(server.origin).hostname, '127.0.0.1');
  const ok = await new Promise((resolve) => {
    const s = net.connect({ host: '::1', port: server.port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  assert.strictEqual(ok, false, 'must not accept on IPv6 loopback');
});

test('serves instrumented HTML with the client and a real location', async (t) => {
  const { port } = await site(t);
  const r = await request(port, { path: '/' });
  const html = r.body.toString();
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.ok(html.includes('<h1 data-cj="index.html:3:1"'));
  assert.ok(html.includes('data-cj-token='));
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.strictEqual(r.headers['cache-control'], 'no-store');
});

test('source files are byte-identical after serving and jumping', async (t) => {
  const { server, root, port } = await site(t);
  const files = ['index.html', 'sub/index.html', 'sub/my page.html', 'style.css', 'pic.png'];
  const before = files.map((f) => sha(fs.readFileSync(path.join(root, f))));
  const mtimes = files.map((f) => fs.statSync(path.join(root, f)).mtimeMs);
  for (const p of ['/', '/sub/', '/sub/my%20page.html', '/style.css', '/pic.png']) await request(port, { path: p });
  await postJump(server, 'index.html:3:1');
  assert.deepStrictEqual(files.map((f) => sha(fs.readFileSync(path.join(root, f)))), before);
  assert.deepStrictEqual(files.map((f) => fs.statSync(path.join(root, f)).mtimeMs), mtimes);
});

test('non-HTML assets are served byte-exact with the right type', async (t) => {
  const { port, root } = await site(t);
  for (const [p, type] of [['/style.css', 'text/css'], ['/app.js', 'text/javascript'], ['/pic.png', 'image/png'], ['/data.bin', 'application/octet-stream']]) {
    const r = await request(port, { path: p });
    assert.strictEqual(r.status, 200, p);
    assert.ok(r.headers['content-type'].startsWith(type), p);
    assert.ok(r.body.equals(fs.readFileSync(path.join(root, p.slice(1)))), p);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(r.headers['cross-origin-resource-policy'], 'same-origin');
  }
});

test('range requests work (Safari needs them for video)', async (t) => {
  const { port } = await site(t);
  const a = await request(port, { path: '/data.bin', headers: { Range: 'bytes=10-19' } });
  assert.strictEqual(a.status, 206);
  assert.strictEqual(a.body.length, 10);
  assert.strictEqual(a.headers['content-range'], 'bytes 10-19/1000');
  const b = await request(port, { path: '/data.bin', headers: { Range: 'bytes=-5' } });
  assert.strictEqual(b.body.length, 5);
  const c = await request(port, { path: '/data.bin', headers: { Range: 'bytes=5000-' } });
  assert.strictEqual(c.status, 416);
});

test('HEAD sends headers and no body', async (t) => {
  const { port } = await site(t);
  const r = await request(port, { method: 'HEAD', path: '/style.css' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 0);
});

test('404s, directory redirect, folder without index', async (t) => {
  const { port } = await site(t);
  assert.strictEqual((await request(port, { path: '/nope.html' })).status, 404);
  const redirect = await request(port, { path: '/sub?x=1' });
  assert.strictEqual(redirect.status, 301);
  assert.strictEqual(redirect.headers.location, '/sub/?x=1');
  assert.strictEqual((await request(port, { path: '/sub/' })).status, 200);
  assert.strictEqual((await request(port, { path: '/empty/' })).status, 404);
  assert.strictEqual((await request(port, { path: '/sub/my%20page.html' })).status, 200);
});

for (const bad of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/sub/../../secret.txt',
  '/sub/%2e%2e/%2e%2e/secret.txt', '/..%5csecret.txt', '/..\\secret.txt', '/index.html%00.png', '/%252e%252e/secret.txt']) {
  test(`traversal blocked: ${bad}`, async (t) => {
    const { port } = await site(t);
    const r = await request(port, { path: bad });
    assert.ok([400, 403, 404].includes(r.status), `got ${r.status}`);
    assert.ok(!r.body.toString().includes('outside secret'));
  });
}

test('malformed percent-encoding is a 400', async (t) => {
  const { port } = await site(t);
  assert.strictEqual((await request(port, { path: '/%zz' })).status, 400);
});

test('protocol-relative path cannot become an open redirect', async (t) => {
  const { port } = await site(t);
  const r = await request(port, { path: '//evil.example/sub' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.headers.location, undefined);
});

test('dotfiles and dot-folders are not served', async (t) => {
  const { port } = await site(t);
  for (const p of ['/.env', '/.git/config', '/%2eenv', '/sub/../.env']) {
    const r = await request(port, { path: p });
    assert.ok([403, 404].includes(r.status), `${p} got ${r.status}`);
    assert.ok(!r.body.toString().includes('SECRET'));
  }
});

test('symlink escaping the root is blocked', { skip: !symlinks }, async (t) => {
  const { port, root, base } = await site(t);
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(base, path.join(root, 'linkdir'));
  assert.strictEqual((await request(port, { path: '/link.txt' })).status, 403);
  assert.strictEqual((await request(port, { path: '/linkdir/secret.txt' })).status, 403);
});

test('symlink inside the root works, but not one pointing at a dotfile', { skip: !symlinks }, async (t) => {
  const { port, root } = await site(t);
  fs.symlinkSync(path.join(root, 'style.css'), path.join(root, 'alias.css'));
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'env.txt'));
  assert.strictEqual((await request(port, { path: '/alias.css' })).status, 200);
  assert.strictEqual((await request(port, { path: '/env.txt' })).status, 404);
});

test('jump: valid request reaches onJump', async (t) => {
  const { server, jumps, root } = await site(t);
  assert.strictEqual((await postJump(server, 'index.html:3:1')).status, 204);
  assert.deepStrictEqual(jumps, [{ file: path.join(root, 'index.html'), rel: 'index.html', line: 3, col: 1 }]);
});

test('jump: encoded filename with a space', async (t) => {
  const { server, jumps } = await site(t);
  assert.strictEqual((await postJump(server, 'sub/my%20page.html:1:1')).status, 204);
  assert.strictEqual(jumps[0].rel, 'sub/my page.html');
});

test('jump: localhost origin is accepted with a localhost host', async (t) => {
  const { server, port } = await site(t);
  const r = await postJump(server, 'index.html:1:1', { Host: `localhost:${port}`, Origin: `http://localhost:${port}` });
  assert.strictEqual(r.status, 204);
});

test('jump: token required', async (t) => {
  const { server, jumps } = await site(t);
  assert.strictEqual((await postJump(server, 'index.html:1:1', { 'X-CJ-Token': 'wrong' })).status, 403);
  assert.strictEqual((await postJump(server, 'index.html:1:1', { 'X-CJ-Token': '' })).status, 403);
  assert.strictEqual(jumps.length, 0);
});

test('jump: foreign, null and missing Origin rejected', async (t) => {
  const { server, jumps, port } = await site(t);
  for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${port + 1}`, `http://127.0.0.1:${port}.evil.example`]) {
    assert.strictEqual((await postJump(server, 'index.html:1:1', { Origin: origin })).status, 403, origin);
  }
  const noOrigin = await request(port, {
    method: 'POST', path: '/__cj/open', headers: { 'X-CJ-Token': server.token, 'Content-Type': 'application/json' }, body: '{"loc":"index.html:1:1"}',
  });
  assert.strictEqual(noOrigin.status, 403);
  assert.strictEqual(jumps.length, 0);
});

test('DNS rebinding: wrong Host rejected on every route', async (t) => {
  const { server, port, jumps } = await site(t);
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `127.0.0.1.evil.example:${port}`, '127.0.0.1']) {
    for (const p of ['/', '/style.css', '/__cj/client.js', `/__cj/events?token=${server.token}`]) {
      assert.strictEqual((await request(port, { path: p, headers: { Host: host } })).status, 403, `${host} ${p}`);
    }
    assert.strictEqual((await postJump(server, 'index.html:1:1', { Host: host })).status, 403, host);
  }
  assert.strictEqual(jumps.length, 0);
});

// Node's client refills an empty Host header, so these go over a raw socket.
for (const [name, head] of [
  ['empty Host', 'GET / HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n'],
  ['no Host (HTTP/1.0)', 'GET / HTTP/1.0\r\n\r\n'],
  ['no Host (HTTP/1.1)', 'GET / HTTP/1.1\r\nConnection: close\r\n\r\n'],
]) {
  test(`DNS rebinding: ${name} rejected`, async (t) => {
    const { port } = await site(t);
    const reply = await new Promise((resolve, reject) => {
      let data = '';
      const sock = net.connect(port, '127.0.0.1', () => sock.write(head));
      sock.on('data', (d) => { data += d; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.[01] (400|403)/);
    assert.ok(!reply.includes('data-cj'));
  });
}

test('jump: text/plain content type rejected (no CORS-simple POST)', async (t) => {
  const { server, jumps } = await site(t);
  assert.strictEqual((await postJump(server, 'index.html:1:1', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual(jumps.length, 0);
});

test('no CORS headers are ever sent; preflight fails', async (t) => {
  const { server, port } = await site(t);
  const r = await request(port, {
    method: 'OPTIONS', path: '/__cj/open',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-cj-token' },
  });
  assert.ok(r.status >= 400);
  assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
  const page = await request(port, { path: '/', headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(page.headers['access-control-allow-origin'], undefined);
  assert.ok(server.token);
});

test('cross-site subresource fetches are blocked, navigation allowed', async (t) => {
  const { port } = await site(t);
  const blocked = await request(port, { path: '/app.js', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'script' } });
  assert.strictEqual(blocked.status, 403);
  const sameSite = await request(port, { path: '/app.js', headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Dest': 'script' } });
  assert.strictEqual(sameSite.status, 403);
  const nav = await request(port, { path: '/', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document' } });
  assert.strictEqual(nav.status, 200);
  const own = await request(port, { path: '/app.js', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'script' } });
  assert.strictEqual(own.status, 200);
});

test('jump: body over the cap is rejected', async (t) => {
  const { server, port, jumps } = await site(t);
  const r = await request(port, {
    method: 'POST', path: '/__cj/open',
    headers: { Origin: server.origin, 'X-CJ-Token': server.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loc: 'a'.repeat(MAX_BODY + 10) }),
  }).catch((e) => ({ status: e.code }));
  assert.ok(r.status === 413 || r.status === 'ECONNRESET' || r.status === 'EPIPE', String(r.status));
  assert.strictEqual(jumps.length, 0);
});

test('jump: chunked body over the cap is rejected', async (t) => {
  const { server, port, jumps } = await site(t);
  const status = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/__cj/open', agent: false,
      headers: { Host: `127.0.0.1:${port}`, Origin: server.origin, 'X-CJ-Token': server.token, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => resolve(e.code));
    req.write('x'.repeat(MAX_BODY));
    req.write('x'.repeat(MAX_BODY));
    req.end();
  });
  assert.ok(status === 413 || status === 'ECONNRESET' || status === 'EPIPE', String(status));
  assert.strictEqual(jumps.length, 0);
});

test('jump: bad payloads', async (t) => {
  const { server, port, jumps } = await site(t);
  const post = (body) => request(port, {
    method: 'POST', path: '/__cj/open', headers: { Origin: server.origin, 'X-CJ-Token': server.token, 'Content-Type': 'application/json' }, body,
  });
  for (const body of ['not json', '{}', '{"loc":5}', '{"loc":"index.html"}', '{"loc":"index.html:0:1"}', 'null']) {
    assert.strictEqual((await post(body)).status, 400, body);
  }
  assert.strictEqual(jumps.length, 0);
});

test('jump: cannot target anything outside root, dotfiles, or non-HTML', async (t) => {
  const { server, jumps, root, base } = await site(t);
  if (symlinks) fs.symlinkSync(path.join(base, 'outside.html'), path.join(root, 'out.html'));
  for (const loc of ['..%2Foutside.html:1:1', '../outside.html:1:1', '.env:1:1', '.git/config:1:1', 'style.css:1:1', 'nope.html:1:1', 'sub:1:1', ...(symlinks ? ['out.html:1:1'] : [])]) {
    const r = await postJump(server, loc);
    assert.ok([400, 403, 404].includes(r.status), `${loc} got ${r.status}`);
  }
  assert.strictEqual(jumps.length, 0);
});

test('jump: GET is not allowed', async (t) => {
  const { port, server } = await site(t);
  assert.strictEqual((await request(port, { path: '/__cj/open', headers: { 'X-CJ-Token': server.token } })).status, 405);
});

test('a throwing onJump returns 500 and the server survives', async (t) => {
  const { server, port } = await site(t, { onJump: () => { throw new Error('boom'); } });
  assert.strictEqual((await postJump(server, 'index.html:1:1')).status, 500);
  assert.strictEqual((await request(port, { path: '/' })).status, 200);
});

test('POST to a normal path is rejected', async (t) => {
  const { port } = await site(t);
  assert.strictEqual((await request(port, { method: 'POST', path: '/index.html', body: 'x' })).status, 405);
});

function openEvents(port, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request({ host: '127.0.0.1', port, path: `/__cj/events?token=${token}`, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => events.push(d));
      res.on('error', () => {});
      resolve({ res, events, close: () => req.destroy() });
    });
    req.on('error', (e) => { if (!events.length) reject(e); });
    req.end();
  });
}

test('events: token required', async (t) => {
  const { port } = await site(t);
  assert.strictEqual((await request(port, { path: '/__cj/events?token=wrong' })).status, 403);
  assert.strictEqual((await request(port, { path: '/__cj/events' })).status, 403);
});

test('events: foreign Origin rejected', async (t) => {
  const { port, server } = await site(t);
  assert.strictEqual((await request(port, { path: `/__cj/events?token=${server.token}`, headers: { Origin: 'https://evil.example' } })).status, 403);
});

for (const [name, change] of [
  ['edit', (root) => fs.writeFileSync(path.join(root, 'index.html'), '<h1>changed</h1>')],
  ['new file', (root) => fs.writeFileSync(path.join(root, 'new.css'), 'a{}')],
  ['delete', (root) => fs.unlinkSync(path.join(root, 'style.css'))],
  ['nested edit', (root) => fs.writeFileSync(path.join(root, 'sub', 'index.html'), '<p>new</p>')],
]) {
  test(`live reload fires on ${name}`, async (t) => {
    const { port, server, root } = await site(t);
    const sse = await openEvents(port, server.token);
    t.after(() => sse.close());
    await waitFor(() => sse.events.join('').includes('event: hello'));
    change(root);
    await waitFor(() => sse.events.join('').includes('event: reload'), 4000, 'reload event');
  });
}

test('live reload ignores .git and node_modules', async (t) => {
  const { port, server, root } = await site(t);
  fs.mkdirSync(path.join(root, 'node_modules'));
  await new Promise((r) => setTimeout(r, 200));
  const sse = await openEvents(port, server.token);
  t.after(() => sse.close());
  await waitFor(() => sse.events.join('').includes('event: hello'));
  fs.writeFileSync(path.join(root, '.git', 'index'), 'x');
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'x');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!sse.events.join('').includes('event: reload'));
});

test('explicit busy port fails with EADDRINUSE', async (t) => {
  const { server, root } = await site(t);
  await assert.rejects(startServer({ root, port: server.port }), { code: 'EADDRINUSE' });
});

test('auto port moves past a busy one', async (t) => {
  const { root } = await site(t);
  const a = await startServer({ root });
  const b = await startServer({ root });
  t.after(async () => { await a.close(); await b.close(); });
  assert.notStrictEqual(a.port, b.port);
  assert.strictEqual((await request(b.port, { path: '/' })).status, 200);
});

test('close ends open event streams and frees the port', async (t) => {
  const base = tmpDir();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, 'index.html'), '<p>x</p>');
  const server = await startServer({ root: base, port: 0 });
  const sse = await openEvents(server.port, server.token);
  const ended = new Promise((r) => { sse.res.on('close', r); });
  await server.close();
  await ended;
  await assert.rejects(request(server.port, { path: '/' }));
  await server.close(); // idempotent
});

test('each run gets a different token', async (t) => {
  const { root, server } = await site(t);
  const other = await startServer({ root, port: 0 });
  t.after(() => other.close());
  assert.notStrictEqual(server.token, other.token);
  assert.ok(server.token.length >= 32);
});
