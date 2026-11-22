'use strict';
// The one check a script cannot do: a real Option+click in the installed Safari.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/core/server');

const PAGE = `<!doctype html>
<html>
<head><title>Click Jump: two clicks</title></head>
<body style="font: 22px system-ui; margin: 60px">
  <h1 id="heading">1. Hold Option and click this heading</h1>
  <p><a id="link" href="other.html">2. Hold Option and click this link</a></p>
</body>
</html>
`;
const lineOf = (needle) => PAGE.slice(0, PAGE.indexOf(needle)).split('\n').length;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-hands-'));
  let navigated = false;
  const beacon = http.createServer((req, res) => { navigated = true; res.end(); });
  await new Promise((resolve) => beacon.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, 'index.html'), PAGE);
  fs.writeFileSync(path.join(root, 'other.html'), `<!doctype html><h1>The link navigated</h1><img src="http://127.0.0.1:${beacon.address().port}/n" alt="">`);
  const seen = new Set();
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const want = [lineOf('<h1'), lineOf('<a id')];
  const server = await startServer({ root, port: 0, onJump: (j) => {
    seen.add(j.line);
    console.log(`jump received: line ${j.line}`);
    if (want.every((l) => seen.has(l))) setTimeout(() => done(true), 1200);
  } });
  spawnSync('open', ['-a', 'Safari', `${server.origin}/index.html`]);
  const ok = await Promise.race([finished, new Promise((resolve) => setTimeout(() => resolve(false), 900000))]);
  const pass = ok && !navigated;
  console.log(pass ? 'safari hands: PASSED, both real Option+clicks jumped and the page stayed' : `safari hands: FAILED (jumps ${[...seen].join(',') || 'none'}, navigated ${navigated})`);
  beacon.close(); beacon.closeAllConnections();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})();
