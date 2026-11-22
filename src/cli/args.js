'use strict';

const BROWSERS = new Set(['safari', 'chrome', 'firefox', 'edge', 'brave', 'arc', 'default']);

function parseArgs(argv) {
  const opts = { target: null, command: null, browser: 'default', terminal: false, editor: null, port: null, open: true };
  const takeValue = (flag, inline, i) => {
    if (inline !== undefined) return { value: inline, next: i };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return { value, next: i + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      if (argv[i + 1] !== undefined) opts.target = argv[i + 1];
      break;
    }
    if (arg === '-h' || arg === '--help') { opts.command = 'help'; continue; }
    if (arg === '-v' || arg === '--version') { opts.command = 'version'; continue; }
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const flag = eq < 0 ? arg : arg.slice(0, eq);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      if (flag === '--safari') opts.browser = 'safari';
      else if (flag === '--terminal') opts.terminal = true;
      else if (flag === '--no-open') opts.open = false;
      else if (flag === '--browser') {
        if (inline !== undefined) opts.browser = inline;
        else if (BROWSERS.has(String(argv[i + 1]).toLowerCase())) opts.browser = argv[++i].toLowerCase();
        else opts.browser = 'default';
      } else if (flag === '--editor') {
        const r = takeValue(flag, inline, i);
        opts.editor = r.value;
        i = r.next;
      } else if (flag === '--port') {
        const r = takeValue(flag, inline, i);
        if (!/^\d{1,5}$/.test(r.value) || Number(r.value) < 1 || Number(r.value) > 65535) {
          throw new Error(`--port must be a number from 1 to 65535, got "${r.value}".`);
        }
        opts.port = Number(r.value);
        i = r.next;
      } else {
        throw new Error(`Unknown option ${flag}. Try click-jump --help.`);
      }
      continue;
    }
    if (arg === 'setup' && opts.target === null && opts.command === null) { opts.command = 'setup'; continue; }
    if (opts.target !== null) throw new Error(`Only one file or folder, got "${opts.target}" and "${arg}".`);
    opts.target = arg;
  }
  return opts;
}

module.exports = { parseArgs, BROWSERS };
