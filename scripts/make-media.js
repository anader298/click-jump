'use strict';
// Builds docs/media from frames captured by the isolated VS Code test run
// (CJ_SHOTS=/some/dir npm run test:vscode) and a headless browser.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startServer } = require('../src/core/server');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'media');
const FRAMES = path.join(process.argv[2] || process.env.CJ_SHOTS, 'frames');

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const timeline = JSON.parse(fs.readFileSync(path.join(FRAMES, 'timeline.json'), 'utf8'));
  const list = path.join(FRAMES, 'list.txt');
  const lines = timeline.flatMap((f) => [`file '${path.join(FRAMES, f.file)}'`, `duration ${f.hold}`]);
  lines.push(`file '${path.join(FRAMES, timeline[timeline.length - 1].file)}'`);
  fs.writeFileSync(list, `${lines.join('\n')}\n`);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf',
    'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-loop', '0', path.join(OUT, 'click-jump-demo.gif')]);
  fs.copyFileSync(path.join(FRAMES, timeline[2].file), path.join(OUT, 'vscode-real.png'));

  const server = await startServer({ root: path.join(ROOT, 'demo'), port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });
  await page.goto(`${server.origin}/index.html`);
  await page.waitForFunction(() => window.__clickJumpLoaded === true);
  await page.keyboard.down('Alt');
  await page.hover('.button');
  await page.waitForSelector('[data-cj-overlay]');
  await page.screenshot({ path: path.join(OUT, 'browser-hover.png') });
  await page.keyboard.up('Alt');
  await browser.close();
  await server.close();
  for (const f of fs.readdirSync(OUT)) console.log(f, fs.statSync(path.join(OUT, f)).size);
})().catch((err) => { console.error(err); process.exit(1); });
