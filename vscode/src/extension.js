'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { startServer, isInside, isHtmlPath } = require('../core/server');

const FLASH_MS = 1100;
const OPENING_MS = 3000; // A new browser tab gets this long to connect before it counts as closed.
const ALT = process.platform === 'darwin' ? 'Option' : 'Alt';

let session = null; // { server, root, openedAt }
let flash = null;   // { deco, editor, timer }
let context = null;

function flashLine(editor, line) {
  clearTimeout(flash.timer);
  flash.editor?.setDecorations(flash.deco, []);
  editor.setDecorations(flash.deco, [new vscode.Range(line, 0, line, 0)]);
  flash.editor = editor;
  flash.timer = setTimeout(() => {
    editor.setDecorations(flash.deco, []);
    flash.editor = null;
  }, FLASH_MS);
}

async function jumpTo({ file, line, col }) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const pos = doc.validatePosition(new vscode.Position(Math.max(line - 1, 0), Math.max(col - 1, 0)));
  // The browser is not a text editor, so these columns can never cover it.
  const code = vscode.window.visibleTextEditors.filter((e) => e.viewColumn);
  const target = code.find((e) => e.document.uri.fsPath === file) ?? code[0];
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: target?.viewColumn ?? vscode.ViewColumn.Beside,
    preview: false,
    selection: new vscode.Range(pos, pos),
  });
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  flashLine(editor, pos.line);
}

function rootFor(file) {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  const realFile = fs.realpathSync(file);
  if (folder?.uri.scheme === 'file') {
    const real = fs.realpathSync(folder.uri.fsPath);
    // Dot-folders are not served, so a page under one gets its own root.
    const hidden = path.relative(real, realFile).split(path.sep).some((s) => s.startsWith('.'));
    if (isInside(real, realFile) && !hidden) return real;
  }
  return path.dirname(realFile);
}

async function stop() {
  const s = session;
  session = null;
  vscode.commands.executeCommand('setContext', 'clickJump.running', false);
  await s?.server.close();
}

// Commands run one at a time so a double-click cannot start two servers.
let queue = Promise.resolve();
function serialized(fn) {
  return (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };
}

async function open(uri) {
  if (vscode.env.remoteName) {
    vscode.window.showWarningMessage('Click Jump does not support remote workspaces yet.');
    return null;
  }
  const file = uri?.scheme === 'file' ? uri.fsPath : vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!file || !isHtmlPath(file) || !fs.existsSync(file)) {
    vscode.window.showInformationMessage('Open an HTML file first, then run Click Jump.');
    return null;
  }
  const root = rootFor(file);
  if (session && session.root !== root) await stop();
  if (!session) {
    const server = await startServer({
      root,
      port: 0,
      onJump: jumpTo,
      onIdle: serialized(() => session?.server === server && stop()), // The browser tab was closed.
      log: (m) => console.warn(`[Click Jump] ${m}`),
    });
    session = { server, root, openedAt: 0 };
    vscode.commands.executeCommand('setContext', 'clickJump.running', true);
  }

  const url = session.server.urlFor(file);
  if (!session.server.navigate(url) && Date.now() - session.openedAt > OPENING_MS) {
    session.openedAt = Date.now();
    await vscode.commands.executeCommand('workbench.action.browser.open', { url, openToSide: true });
    if (!context.globalState.get('clickJump.hintShown')) {
      context.globalState.update('clickJump.hintShown', true);
      vscode.window.showInformationMessage(`Click Jump is running. Hold ${ALT} and click anything in the preview.`);
    }
  }
  return { url, port: session.server.port, token: session.server.token };
}

function activate(ctx) {
  context = ctx;
  flash = {
    editor: null,
    timer: null,
    deco: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(255, 196, 0, 0.42)',
      overviewRulerColor: 'rgba(255, 196, 0, 0.9)',
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    }),
  };
  ctx.subscriptions.push(
    flash.deco,
    vscode.commands.registerCommand('clickJump.open', serialized(open)),
    vscode.commands.registerCommand('clickJump.stop', serialized(stop)),
    { dispose: () => { stop(); } },
  );
  return {
    // Read-only state for the integration test.
    _state: () => ({
      running: !!session,
      port: session ? session.server.port : null,
      flashing: !!flash.editor,
      flashEditorColumn: flash.editor ? flash.editor.viewColumn : null,
    }),
  };
}

const deactivate = stop;

module.exports = { activate, deactivate };
