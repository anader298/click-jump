'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAC_APPS = {
  safari: 'Safari', chrome: 'Google Chrome', firefox: 'Firefox', edge: 'Microsoft Edge', brave: 'Brave Browser', arc: 'Arc',
};
const LINUX_BINS = {
  chrome: ['google-chrome', 'chromium', 'chromium-browser'], firefox: ['firefox'], edge: ['microsoft-edge'], brave: ['brave-browser'],
};
const WIN_START = { chrome: 'chrome', firefox: 'firefox', edge: 'msedge', brave: 'brave' };
const GOTO_EDITORS = new Set(['code', 'code-insiders', 'codium', 'cursor', 'windsurf']);
const COLON_EDITORS = new Set(['subl', 'zed']);
const MAC_EDITOR_PATHS = {
  code: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  cursor: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  windsurf: '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
};

/** Finds an executable on PATH without invoking a shell. */
function which(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(full, fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Splits a command template on spaces, honouring quotes. Never uses a shell. */
function splitCommand(str) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of str) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error(`Unclosed quote in editor command: ${str}`);
  if (has || cur) out.push(cur);
  return out;
}

/** Builds [command, ...args] for a jump. The file is always a single argv entry. */
function editorArgv(editor, { file, line, col }) {
  const spot = `${file}:${line}:${col}`;
  if (/[{]file[}]/.test(editor)) {
    return splitCommand(editor).map((part) => part
      .replaceAll('{file}', file).replaceAll('{line}', String(line)).replaceAll('{col}', String(col)));
  }
  const parts = splitCommand(editor);
  const base = path.basename(parts[0]).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
  if (GOTO_EDITORS.has(base)) return [...parts, '--reuse-window', '--goto', spot];
  if (COLON_EDITORS.has(base)) return [...parts, spot];
  return [...parts, spot];
}

function detectEditor(env = process.env, platform = process.platform) {
  if (env.CLICK_JUMP_EDITOR) return env.CLICK_JUMP_EDITOR;
  for (const name of ['code', 'cursor', 'windsurf', 'codium', 'zed', 'subl']) {
    if (which(name, env, platform)) return name;
  }
  if (platform === 'darwin') {
    for (const p of Object.values(MAC_EDITOR_PATHS)) if (fs.existsSync(p)) return `"${p}"`;
  }
  return null;
}

// cmd.exe re-parses its command line, and % cannot be escaped inside quotes.
// Rather than guess at escaping, refuse paths containing its metacharacters.
const CMD_UNSAFE = /[%^&|<>!"\r\n]/;

/** Windows .cmd shims need cmd.exe. Returns spawn parameters, or throws. */
function windowsCmdSpawn(argv) {
  for (const a of argv) {
    if (CMD_UNSAFE.test(a)) {
      throw new Error(`This path has a character cmd.exe treats specially, so the editor was not launched: ${a}`);
    }
  }
  const line = argv.map((a) => `"${a}"`).join(' ');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

function runEditor(argv, platform = process.platform) {
  let [command, ...args] = argv;
  const extra = {};
  if (platform === 'win32') {
    const resolved = path.isAbsolute(command) ? command : which(command) || command;
    if (/\.(cmd|bat)$/i.test(resolved)) {
      const w = windowsCmdSpawn([resolved, ...args]);
      command = w.command;
      args = w.args;
      extra.windowsVerbatimArguments = true;
    } else {
      command = resolved;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: platform !== 'win32', windowsHide: true, ...extra });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Returns the argv that opens url in the browser, without a shell. */
function browserArgv(browser, url, platform = process.platform, find = which) {
  const name = String(browser || 'default');
  const key = name.toLowerCase();
  if (platform === 'darwin') {
    if (key === 'default') return ['open', url];
    return ['open', '-a', MAC_APPS[key] || name, url];
  }
  if (key === 'safari') throw new Error('Safari is only available on macOS.');
  if (platform === 'win32') {
    if (key === 'default') return ['rundll32', 'url.dll,FileProtocolHandler', url];
    const exe = WIN_START[key];
    if (!exe) throw new Error(`Unknown browser "${name}". Use chrome, firefox, edge or brave.`);
    return ['cmd.exe', '/d', '/c', 'start', '""', exe, url];
  }
  if (key === 'default') return ['xdg-open', url];
  for (const bin of LINUX_BINS[key] || [name]) {
    if (find(bin)) return [bin, url];
  }
  throw new Error(`Could not find browser "${name}" on PATH.`);
}

function openBrowser(browser, url) {
  if (process.env.CLICK_JUMP_NO_OPEN) return Promise.resolve(false);
  const [command, ...args] = browserArgv(browser, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}

function hasVim() {
  if (!which('vim')) return false;
  const r = spawnSync('vim', ['--version'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 && /\+timers/.test(r.stdout);
}

module.exports = {
  which, splitCommand, editorArgv, detectEditor, runEditor, windowsCmdSpawn, browserArgv, openBrowser, hasVim, MAC_APPS,
};
