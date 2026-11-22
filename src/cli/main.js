'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, isHtmlPath } = require('../core/server');
const { parseArgs } = require('./args');
const launch = require('./launch');

const HELP = `click-jump: hold Option (Alt on Windows/Linux) and click anything in a live
preview to jump to its source line. Save and the page reloads.

Usage
  click-jump [file-or-folder] [options]
  click-jump setup          Check what is installed (changes nothing)

With no path, it serves the current folder and opens index.html.

Options
  --safari            Open the preview in Safari (macOS)
  --browser [name]    safari, chrome, firefox, edge, brave, arc, or an app name
  --terminal          Edit in Vim in this terminal. Vim follows your clicks
  --editor <cmd>      code, cursor, windsurf, zed, subl, or a template such as
                      "mate -l {line} {file}"
  --port <n>          Use this port (fails if it is busy)
  --no-open           Do not open a browser
  -h, --help          Show this help
  -v, --version       Show the version

Your files are never modified. The server listens on 127.0.0.1 only.
`;

/** Decides what to serve. Returns { root, page }. */
function resolveTarget(target, cwd = process.cwd()) {
  const given = path.resolve(cwd, target || '.');
  let stat;
  try {
    stat = fs.statSync(given);
  } catch {
    throw new Error(`Not found: ${given}`);
  }
  if (stat.isFile()) {
    if (!isHtmlPath(given)) throw new Error(`Not an HTML file: ${given}`);
    return { root: path.dirname(given), page: given };
  }
  for (const name of ['index.html', 'index.htm']) {
    const p = path.join(given, name);
    if (fs.existsSync(p)) return { root: given, page: p };
  }
  const pages = fs.readdirSync(given).filter((n) => isHtmlPath(n) && !n.startsWith('.')).sort();
  if (pages.length) return { root: given, page: path.join(given, pages[0]), others: pages.length - 1 };
  throw new Error(`No HTML file in ${given}. Pass one: click-jump path/to/page.html`);
}

/** Line text to character column, used by Vim which counts differently from VS Code. */
function charColumn(file, line, col) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/);
    const text = (lines[line - 1] || '').replace(/^﻿/, '');
    return [...text.slice(0, col - 1)].length + 1;
  } catch {
    return col;
  }
}

function writeSignal(signalPath, jump) {
  const tmp = `${signalPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    id: crypto.randomBytes(8).toString('hex'),
    file: jump.file,
    line: jump.line,
    col: charColumn(jump.file, jump.line, jump.col),
  }), { mode: 0o600 });
  fs.renameSync(tmp, signalPath);
}

function runSetup() {
  const rows = [];
  const editor = launch.detectEditor();
  rows.push(['Node', process.version]);
  rows.push(['Editor', editor ? editor.replaceAll('"', '') : 'none found (use --editor or --terminal)']);
  rows.push(['Vim with timers', launch.hasVim() ? 'yes, --terminal will work' : 'no, --terminal needs Vim 8+']);
  if (process.platform === 'darwin') {
    rows.push(['Safari', fs.existsSync('/Applications/Safari.app') ? 'yes, --safari will work' : 'not found']);
  }
  console.log('click-jump setup (read-only check)\n');
  for (const [k, v] of rows) console.log(`  ${k.padEnd(16)} ${v}`);
  console.log(`
To run it from any folder without a long path:

  npm install --global .     from a clone of this repo

Then, in any folder with an index.html:

  click-jump
`);
  return 0;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`click-jump: ${err.message}`);
    return 2;
  }
  if (opts.command === 'help') { process.stdout.write(HELP); return 0; }
  if (opts.command === 'version') { console.log(require('../../package.json').version); return 0; }
  if (opts.command === 'setup') return runSetup();

  let target;
  try {
    target = resolveTarget(opts.target);
  } catch (err) {
    console.error(`click-jump: ${err.message}`);
    return 1;
  }

  if (opts.terminal && !launch.hasVim()) {
    console.error('click-jump: --terminal needs Vim 8 or newer with +timers.');
    return 1;
  }

  const editor = opts.terminal ? null : (opts.editor || launch.detectEditor());
  let signalDir = null;
  let signalPath = null;
  if (opts.terminal) {
    signalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'click-jump-'));
    signalPath = path.join(signalDir, 'flash.json');
  }

  const onJump = async (jump) => {
    if (opts.terminal) {
      writeSignal(signalPath, jump);
      return;
    }
    console.log(`${path.relative(process.cwd(), jump.file) || jump.file}:${jump.line}:${jump.col}`);
    if (editor) await launch.runEditor(launch.editorArgv(editor, jump));
  };

  let server;
  try {
    server = await startServer({
      root: target.root,
      port: opts.port,
      onJump,
      log: (m) => console.error(`click-jump: ${m}`),
    });
  } catch (err) {
    if (signalDir) fs.rmSync(signalDir, { recursive: true, force: true });
    if (err.code === 'EADDRINUSE') {
      console.error(`click-jump: port ${opts.port} is in use. Drop --port to pick a free one.`);
      return 1;
    }
    throw err;
  }

  const url = server.urlFor(target.page);
  let stopping = null;
  const stop = () => {
    if (!stopping) {
      stopping = server.close().then(() => {
        if (signalDir) fs.rmSync(signalDir, { recursive: true, force: true });
      });
    }
    return stopping;
  };

  if (opts.terminal) {
    if (opts.open) await launch.openBrowser(opts.browser, url).catch((e) => console.error(`click-jump: ${e.message}`));
    console.log(`Preview: ${url}`);
    const vimScript = path.join(__dirname, 'click-jump.vim');
    const code = await new Promise((resolve) => {
      const vim = spawn('vim', ['-S', vimScript, '--', target.page], {
        stdio: 'inherit',
        env: { ...process.env, CLICK_JUMP_SIGNAL: signalPath },
      });
      // Vim handles Ctrl+C itself while it owns the terminal.
      const ignore = () => {};
      process.on('SIGINT', ignore);
      vim.once('error', (e) => { console.error(`click-jump: ${e.message}`); resolve(1); });
      vim.once('exit', (c) => { process.removeListener('SIGINT', ignore); resolve(c ?? 0); });
    });
    await stop();
    return code;
  }

  console.log(`Preview: ${url}`);
  if (target.others) console.log(`Opened ${path.basename(target.page)}. ${target.others} other HTML file(s) in this folder.`);
  console.log(editor
    ? `Clicks open in: ${editor.replaceAll('"', '')}`
    : 'No editor found. Clicks print file:line here. Use --editor or --terminal.');
  const altName = process.platform === 'darwin' ? 'Option' : 'Alt';
  console.log(`Hold ${altName} and click anything. Press Ctrl+C to stop.`);
  if (opts.open) {
    try {
      await launch.openBrowser(opts.browser, url);
    } catch (err) {
      console.error(`click-jump: could not open the browser (${err.message}). Open the URL above.`);
    }
  }

  await new Promise((resolve) => {
    const finish = () => stop().then(resolve);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  return 0;
}

module.exports = { main, resolveTarget, charColumn };
