'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { startServer, isInside, isHtmlPath } = require('../core/server');

const FLASH_MS = 1100;
const HINT_KEY = 'clickJump.hintShown';
const ALT = process.platform === 'darwin' ? 'Option' : 'Alt';

let session = null; // { server, panel, root }
let flash = null;   // { deco, editor, timer }
let context = null;

function flashLine(editor, line) {
  if (!flash) {
    flash = {
      deco: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: 'rgba(255, 196, 0, 0.42)',
        overviewRulerColor: 'rgba(255, 196, 0, 0.9)',
        overviewRulerLane: vscode.OverviewRulerLane.Full,
      }),
      editor: null,
      timer: null,
    };
    context.subscriptions.push(flash.deco);
  }
  clearTimeout(flash.timer);
  if (flash.editor && flash.editor !== editor) flash.editor.setDecorations(flash.deco, []);
  editor.setDecorations(flash.deco, [new vscode.Range(line, 0, line, 0)]);
  flash.editor = editor;
  flash.timer = setTimeout(() => {
    editor.setDecorations(flash.deco, []);
    flash.editor = null;
  }, FLASH_MS);
}

/** Where the preview is right now. panel.viewColumn lags just after creation. */
function previewColumnNow() {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('clickJump.preview')) {
        return group.viewColumn;
      }
    }
  }
  return session && session.panel ? session.panel.viewColumn : undefined;
}

/** The column for code: anything except the one holding the preview. */
function codeColumn(file) {
  const previewColumn = previewColumnNow();
  const visible = vscode.window.visibleTextEditors.filter((e) => e.viewColumn && e.viewColumn !== previewColumn);
  const same = visible.find((e) => e.document.uri.fsPath === file);
  if (same) return same.viewColumn;
  const active = vscode.window.activeTextEditor;
  if (active && active.viewColumn && active.viewColumn !== previewColumn) return active.viewColumn;
  if (visible.length) return visible[0].viewColumn;
  return previewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
}

async function jumpTo({ file, line, col }) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const zeroLine = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
  const zeroCol = Math.min(Math.max(col - 1, 0), doc.lineAt(zeroLine).text.length);
  const pos = new vscode.Position(zeroLine, zeroCol);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: codeColumn(file),
    preserveFocus: false,
    preview: false,
    selection: new vscode.Range(pos, pos),
  });
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  flashLine(editor, zeroLine);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function previewHtml(url, origin) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = `default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
html,body{height:100%;margin:0;padding:0;overflow:hidden;background:var(--vscode-editor-background)}
iframe{display:block;width:100%;height:100%;border:0;background:#fff}
</style></head><body>
<iframe id="site" title="Click Jump preview" src="${escapeHtml(url)}"></iframe>
<script nonce="${nonce}">
const frame = document.getElementById('site');
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'navigate') frame.src = e.data.url;
});
</script></body></html>`;
}

function rootFor(file) {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  if (folder && folder.uri.scheme === 'file') {
    const real = fs.realpathSync(folder.uri.fsPath);
    const realFile = fs.realpathSync(file);
    // Dot-folders are not served, so a page under one gets its own root.
    const rel = path.relative(real, realFile);
    if (isInside(real, realFile) && !rel.split(path.sep).some((s) => s.startsWith('.'))) return real;
  }
  return path.dirname(fs.realpathSync(file));
}

async function stop() {
  const s = session;
  session = null;
  vscode.commands.executeCommand('setContext', 'clickJump.running', false);
  if (!s) return;
  if (s.panel) {
    s.panel.onDidDisposeHandler?.dispose();
    s.panel.dispose();
  }
  await s.server.close();
}

function targetFile(uri) {
  if (uri instanceof vscode.Uri && uri.scheme === 'file') return uri.fsPath;
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.scheme === 'file') return active.document.uri.fsPath;
  return null;
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
  const file = targetFile(uri);
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
      // CSP checks every ancestor: the webview and the workbench page above it.
      frameAncestors: "'self' vscode-webview: vscode-file:",
      onJump: jumpTo,
      log: (m) => console.warn(`[Click Jump] ${m}`),
    });
    session = { server, root, panel: null };
    vscode.commands.executeCommand('setContext', 'clickJump.running', true);
  }

  const url = session.server.urlFor(file);
  if (session.panel) {
    session.panel.reveal(session.panel.viewColumn, true);
    session.panel.webview.postMessage({ type: 'navigate', url });
  } else {
    const panel = vscode.window.createWebviewPanel(
      'clickJump.preview',
      'Click Jump',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    panel.iconPath = new vscode.ThemeIcon('inspect');
    panel.webview.html = previewHtml(url, session.server.origin);
    const current = session;
    panel.onDidDisposeHandler = panel.onDidDispose(() => {
      if (session === current) {
        current.panel = null;
        stop();
      }
    });
    session.panel = panel;
  }

  if (!context.globalState.get(HINT_KEY)) {
    context.globalState.update(HINT_KEY, true);
    vscode.window.showInformationMessage(`Click Jump is running. Hold ${ALT} and click anything in the preview.`);
  }
  return { url, port: session.server.port, token: session.server.token };
}

function activate(ctx) {
  context = ctx;
  ctx.subscriptions.push(
    vscode.commands.registerCommand('clickJump.open', serialized(open)),
    vscode.commands.registerCommand('clickJump.stop', serialized(stop)),
    { dispose: () => { stop(); } },
  );
  return {
    // Read-only state for the integration test.
    _state: () => ({
      running: !!session,
      port: session ? session.server.port : null,
      previewColumn: session && session.panel ? previewColumnNow() ?? null : null,
      flashing: !!(flash && flash.editor),
      flashEditorColumn: flash && flash.editor ? flash.editor.viewColumn : null,
    }),
  };
}

async function deactivate() {
  await stop();
}

module.exports = { activate, deactivate };
