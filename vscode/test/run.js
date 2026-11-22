'use strict';
// Runs the extension tests in a throwaway VS Code. On macOS the copy is patched
// so it cannot show a window. If that cannot be guaranteed, the run is skipped.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

const VERSION = process.env.CJ_VSCODE_VERSION || '1.138.0';
const CACHE = process.env.CJ_VSCODE_CACHE || path.join(os.tmpdir(), 'cj-vscode');
const EXT = path.join(__dirname, '..');
const SKIP = 77;

function hideMacCopy(exe) {
  const app = exe.slice(0, exe.indexOf('.app/') + 4);
  const plist = path.join(app, 'Contents', 'Info.plist');
  const appDir = path.join(app, 'Contents', 'Resources', 'app');
  const main = path.join(appDir, 'out', 'main.js');
  if (![fs.realpathSync(os.tmpdir()), os.tmpdir(), '/tmp/', '/private/tmp/'].some((d) => app.startsWith(d))) {
    throw new Error(`refusing to patch a VS Code outside the temp folder: ${app}`);
  }
  const plutil = (...a) => spawnSync('plutil', a, { encoding: 'utf8' });
  plutil('-replace', 'LSBackgroundOnly', '-bool', 'YES', plist);
  plutil('-replace', 'CFBundleIdentifier', '-string', 'test.clickjump.isolated', plist);
  plutil('-remove', 'CFBundleURLTypes', plist);
  plutil('-remove', 'CFBundleDocumentTypes', plist);
  fs.copyFileSync(path.join(__dirname, 'hidden-electron.mjs'), path.join(appDir, 'out', 'cj-electron.mjs'));
  let code = fs.readFileSync(main, 'utf8');
  code = code.replaceAll('from"electron"', 'from"./cj-electron.mjs"').replaceAll('import("electron")', 'import("./cj-electron.mjs")');
  fs.writeFileSync(main, code);

  // Verify every guard before launching anything.
  const info = plutil('-convert', 'json', '-o', '-', plist);
  const parsed = JSON.parse(info.stdout);
  const after = fs.readFileSync(main, 'utf8');
  const ok = parsed.LSBackgroundOnly === true
    && parsed.CFBundleIdentifier === 'test.clickjump.isolated'
    && !parsed.CFBundleURLTypes
    && !after.includes('from"electron"')
    && !after.includes('import("electron")')
    && !after.includes('require("electron")')
    && after.includes('./cj-electron.mjs');
  if (!ok) throw new Error('could not verify the hidden-window patch');

  // Editing Info.plist breaks the signature and macOS kills the process, so
  // the throwaway copy gets a local ad-hoc signature. No keychain is involved.
  const marker = path.join(path.dirname(app), '.cj-signed');
  if (!fs.existsSync(marker)) {
    const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { encoding: 'utf8' });
    if (signed.status !== 0) throw new Error(`could not re-sign the temp copy: ${signed.stderr}`);
    fs.writeFileSync(marker, 'ok');
  }
}

// Linux and Windows: same hidden-window shim, so real clicks can be driven in CI.
function patchOtherCopy(exe, cache) {
  if (!exe.startsWith(cache)) throw new Error(`refusing to patch a VS Code outside the cache: ${exe}`);
  const base = path.dirname(exe);
  const dirs = [base, ...fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name))];
  const appDir = dirs.map((d) => path.join(d, 'resources', 'app')).find((d) => fs.existsSync(path.join(d, 'out', 'main.js')));
  if (!appDir) throw new Error('could not find VS Code main.js');
  const main = path.join(appDir, 'out', 'main.js');
  fs.copyFileSync(path.join(__dirname, 'hidden-electron.mjs'), path.join(appDir, 'out', 'cj-electron.mjs'));
  let code = fs.readFileSync(main, 'utf8');
  code = code.replaceAll('from"electron"', 'from"./cj-electron.mjs"').replaceAll('import("electron")', 'import("./cj-electron.mjs")');
  fs.writeFileSync(main, code);
  if (!code.includes('./cj-electron.mjs') || code.includes('from"electron"')) throw new Error('could not verify the patch');
}

async function main() {
  if (!process.env.CJ_EXT_PATH) require('../../scripts/sync-core');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
  }
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cj-vsc-run-')));
  const site = path.join(work, 'site');
  fs.cpSync(path.join(EXT, '..', 'demo'), site, { recursive: true });
  const controlFile = path.join(work, 'control-port');
  process.env.CJ_CONTROL_FILE = controlFile;

  fs.mkdirSync(CACHE, { recursive: true });
  // VS Code rejects its own files if launched through a symlinked path (/tmp on macOS).
  const exe = await downloadAndUnzipVSCode({ version: VERSION, cachePath: fs.realpathSync(CACHE) });
  if (process.platform === 'darwin') {
    try {
      hideMacCopy(exe);
    } catch (err) {
      console.log(`SKIPPED: ${err.message}`);
      return SKIP;
    }
  } else if (process.platform === 'linux' && !process.env.DISPLAY) {
    console.log('SKIPPED: no DISPLAY. Run under xvfb-run.');
    return SKIP;
  }
  if (process.platform !== 'darwin') patchOtherCopy(exe, fs.realpathSync(CACHE));

  // A hung instance must not outlive the run. The path is unique to the temp copy.
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    console.error('VS Code tests timed out');
    if (process.platform !== 'win32') spawnSync('pkill', ['-f', path.dirname(path.dirname(exe))]);
  }, Number(process.env.CJ_VSCODE_TIMEOUT_MS || 150000));

  try {
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: process.env.CJ_EXT_PATH || EXT,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      extensionTestsEnv: {
        CJ_CONTROL_FILE: controlFile,
        CJ_SITE: site,
        CJ_SHOTS: process.env.CJ_SHOTS || '',
      },
      launchArgs: [
        site,
        `--user-data-dir=${path.join(work, 'user')}`,
        `--extensions-dir=${path.join(work, 'extensions')}`,
        '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes',
        '--disable-telemetry', '--use-mock-keychain', '--password-store=basic', '--disable-gpu',
      ],
    });
    // A killed instance can still report exit code 0, so it must not count as a pass.
    return timedOut ? 1 : 0;
  } catch (err) {
    console.error(`VS Code tests failed: ${err.message || err}`);
    return 1;
  } finally {
    clearTimeout(watchdog);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
