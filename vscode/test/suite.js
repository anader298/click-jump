'use strict';
// Runs inside the isolated VS Code.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

const SITE = process.env.CJ_SITE;
const SHOTS = process.env.CJ_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function control(body) {
  const port = Number(fs.readFileSync(process.env.CJ_CONTROL_FILE, 'utf8'));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed.value);
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) { last = err; }
    if (Date.now() > end) throw new Error(`Timed out: ${what}${last ? ` (${last.message})` : ''}`);
    await sleep(60);
  }
}

const samePath = (a, b) => fs.realpathSync.native(a) === fs.realpathSync.native(b);

const lineOf = (file, needle) => {
  const text = fs.readFileSync(file, 'utf8');
  return text.slice(0, text.indexOf(needle)).split('\n').length;
};

// VS Code reports Integrated Browser tabs with no input type.
const browserTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input === undefined);

function previewVisible(column) {
  const tab = vscode.window.tabGroups.all.find((g) => g.viewColumn === column)?.activeTab;
  return !!tab && tab.input === undefined;
}

async function run() {
  const results = [];
  const index = path.join(SITE, 'index.html');
  const menu = path.join(SITE, 'menu', 'index.html');
  const before = sha(index);
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'click-jump');
  let api;
  let port;
  let frame;
  let sawFlash = false;

  const step = async (name, fn) => {
    try {
      await fn();
      results.push([name, true]);
      console.log(`pass  ${name}`);
    } catch (err) {
      results.push([name, false]);
      console.log(`FAIL  ${name}: ${err.message}`);
    }
  };

  await step('extension is present and activates', async () => {
    assert.ok(ext);
    api = await ext.activate();
    assert.ok(api._state);
  });

  await step('commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('clickJump.open'));
    assert.ok(all.includes('clickJump.stop'));
  });

  await step('title bar, editor and Explorer menus are contributed', () => {
    const menus = ext.packageJSON.contributes.menus;
    for (const m of ['editor/title', 'editor/context', 'explorer/context']) {
      assert.ok(menus[m].some((x) => x.command === 'clickJump.open'), m);
    }
  });

  await step('open starts the server and a preview beside the code', async () => {
    const doc = await vscode.workspace.openTextDocument(index);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const r = await vscode.commands.executeCommand('clickJump.open');
    port = r.port;
    frame = `127.0.0.1:${port}`;
    assert.strictEqual(api._state().running, true);
    await until(() => previewVisible(vscode.ViewColumn.Two), 'preview tab active');
  });

  await step('the Integrated Browser loads the instrumented page', async () => {
    await until(async () => (await control({ op: 'frames' })).some((u) => u.includes(frame)), 'preview frame');
    await until(() => control({ op: 'eval', part: frame, code: `!!window.__clickJumpLoaded && !!document.querySelector('h1[data-cj]')` }), 'client loaded');
  });

  await step('no window of the test instance is visible', async () => {
    const st = await control({ op: 'state' });
    assert.ok(st.length > 0);
    assert.ok(st.every((w) => !w.visible), JSON.stringify(st));
  });

  await step('real Option+click in the preview jumps to the right line', async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(index), vscode.ViewColumn.One);
    await control({ op: 'altClick', part: frame, selector: '.card:nth-child(2) h2' });
    const want = lineOf(index, 'Cardamom bun') - 1;
    await until(() => vscode.window.activeTextEditor?.selection.active.line === want, `cursor on line ${want + 1}`);
    assert.ok(samePath(vscode.window.activeTextEditor.document.uri.fsPath, index));
  });

  await step('the flash decoration applies in the code column', async () => {
    await until(() => api._state().flashing, 'flash');
    sawFlash = true;
    assert.strictEqual(api._state().flashEditorColumn, vscode.ViewColumn.One);
    if (SHOTS) await control({ op: 'capture', file: path.join(SHOTS, 'vscode-real.png') });
  });

  await step('the preview is not covered by the jump', () => {
    assert.ok(sawFlash, 'no jump happened');
    assert.ok(previewVisible(vscode.ViewColumn.Two));
    assert.strictEqual(vscode.window.activeTextEditor.viewColumn, vscode.ViewColumn.One);
  });

  await step('the flash clears after about a second', async () => {
    assert.ok(sawFlash, 'no flash was seen, so there is nothing to clear');
    await until(() => !api._state().flashing, 'flash cleared', 3000);
  });

  await step('Option+click on a link jumps and does not navigate', async () => {
    const url = await control({ op: 'eval', part: frame, code: 'location.href' });
    await control({ op: 'altClick', part: frame, selector: 'a.button' });
    const want = lineOf(index, 'class="button"') - 1;
    await until(() => vscode.window.activeTextEditor?.selection.active.line === want, 'cursor on link line');
    await sleep(250);
    assert.strictEqual(await control({ op: 'eval', part: frame, code: 'location.href' }), url);
  });

  await step('jumping from a second page opens that file, keeping the preview', async () => {
    await control({ op: 'eval', part: frame, code: `location.href = '/menu/index.html'; 1` }).catch(() => {});
    await until(() => control({ op: 'eval', part: frame, code: `location.pathname === '/menu/index.html' && !!window.__clickJumpLoaded` }), 'menu page');
    await control({ op: 'altClick', part: frame, selector: 'li:nth-child(3)' });
    await until(() => vscode.window.activeTextEditor && samePath(vscode.window.activeTextEditor.document.uri.fsPath, menu), 'menu file opened');
    await until(() => vscode.window.activeTextEditor.selection.active.line === lineOf(menu, 'Cardamom bun') - 1, 'menu line');
    assert.strictEqual(vscode.window.activeTextEditor.viewColumn, vscode.ViewColumn.One);
    assert.ok(previewVisible(vscode.ViewColumn.Two));
  });

  await step('running open on another file reuses the preview', async () => {
    await vscode.commands.executeCommand('clickJump.open', vscode.Uri.file(index));
    assert.strictEqual(api._state().port, port);
    await until(() => control({ op: 'eval', part: frame, code: `location.pathname === '/index.html' && !!window.__clickJumpLoaded` }), 'back on index');
    assert.strictEqual(browserTabs().length, 1);
  });

  await step('source is byte-identical before any edit', () => {
    assert.strictEqual(sha(index), before);
  });

  await step('editing and saving reloads the preview', async () => {
    const doc = await vscode.workspace.openTextDocument(index);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const at = doc.getText().indexOf('Bread worth getting up for.');
    await editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(at), doc.positionAt(at + 27)), 'Saved from the editor.'));
    await doc.save();
    await until(() => control({ op: 'eval', part: frame, code: `document.querySelector('h1')?.textContent === 'Saved from the editor.'` }), 'reloaded heading');
    const fresh = doc.getText().indexOf('Saved from the editor.');
    await editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(fresh), doc.positionAt(fresh + 22)), 'Bread worth getting up for.'));
    await doc.save();
    await until(() => control({ op: 'eval', part: frame, code: `document.querySelector('h1')?.textContent === 'Bread worth getting up for.'` }), 'restored heading');
    assert.strictEqual(sha(index), before);
  });

  await step('opening with unsaved edits does not write the file', async () => {
    const doc = await vscode.workspace.openTextDocument(index);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '<!-- unsaved -->'));
    assert.ok(doc.isDirty);
    await vscode.commands.executeCommand('clickJump.open', vscode.Uri.file(index));
    assert.ok(doc.isDirty, 'still unsaved');
    assert.strictEqual(sha(index), before);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await until(() => !doc.isDirty, 'reverted');
  });

  await step('two quick opens share one server and one preview', async () => {
    const [a, b] = await Promise.all([
      vscode.commands.executeCommand('clickJump.open', vscode.Uri.file(index)),
      vscode.commands.executeCommand('clickJump.open', vscode.Uri.file(index)),
    ]);
    assert.strictEqual(a.port, b.port);
    assert.strictEqual(browserTabs().length, 1);
    await until(() => control({ op: 'eval', part: frame, code: `location.pathname === '/index.html' && !!window.__clickJumpLoaded` }), 'index loaded');
  });

  if (SHOTS) {
    await step('capture demo frames from this real instance', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('notifications.clearAll');
      await sleep(500);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(index), vscode.ViewColumn.One);
      await sleep(400);
      const icon = await control({ op: 'eval', part: 'workbench', code: `(() => { const b = document.querySelector('.editor-group-container.active a[aria-label*="Open in Click Jump"]').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()` });
      fs.writeFileSync(path.join(SHOTS, 'icon.json'), JSON.stringify(icon));
      await control({ op: 'capture', file: path.join(SHOTS, 'button-raw.png') });
      const dir = path.join(SHOTS, 'frames');
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      const timeline = [];
      const shot = async (hold) => {
        const file = `${String(n++).padStart(3, '0')}.png`;
        await control({ op: 'capture', file: path.join(dir, file) });
        timeline.push({ file, hold });
      };
      const target = '.card:nth-child(2) h2';
      const center = `document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'center'}); 1`;
      await control({ op: 'eval', part: frame, code: center });
      const doc = await vscode.workspace.openTextDocument(index);
      let editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const top = new vscode.Position(0, 0);
      editor.selection = new vscode.Selection(top, top);
      editor.revealRange(new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);
      await sleep(350);
      await control({ op: 'hover', part: frame, selector: 'footer p', alt: false });
      await sleep(150);
      await shot(1.1);
      await control({ op: 'hover', part: frame, selector: target, alt: true });
      await sleep(200);
      await shot(0.9);
      await control({ op: 'altClick', part: frame, selector: target });
      await until(() => api._state().flashing, 'flash for demo');
      await sleep(120);
      await shot(1.1);
      await control({ op: 'hover', part: frame, selector: 'footer p', alt: false });
      await until(() => !api._state().flashing, 'flash end for demo', 3000);
      await sleep(120);
      await shot(0.5);
      editor = vscode.window.activeTextEditor;
      const start = doc.getText().indexOf('Cardamom bun') + 'Cardamom '.length;
      await editor.edit((b) => b.delete(new vscode.Range(doc.positionAt(start), doc.positionAt(start + 3))));
      await sleep(60);
      await shot(0.25);
      const word = 'knot';
      for (let i = 0; i < word.length; i++) {
        await editor.edit((b) => b.insert(doc.positionAt(start + i), word[i]));
        const end = doc.positionAt(start + i + 1);
        editor.selection = new vscode.Selection(end, end);
        await sleep(60);
        await shot(0.16);
      }
      await doc.save();
      await until(() => control({ op: 'eval', part: frame, code: `document.querySelector(${JSON.stringify(target)})?.textContent === 'Cardamom knot'` }), 'demo reload');
      await control({ op: 'eval', part: frame, code: center });
      await sleep(250);
      await shot(2.2);
      fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline));
      const fixed = doc.getText().indexOf('Cardamom knot') + 'Cardamom '.length;
      await editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(fixed), doc.positionAt(fixed + 4)), 'bun'));
      await doc.save();
      await until(() => sha(index) === before, 'demo source restored');
    });
  }

  await step('hiding the browser tab keeps the server running', async () => {
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === vscode.ViewColumn.Two);
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    await vscode.commands.executeCommand('workbench.action.toggleEditorGroupLock').then(() => 0, () => 0);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(menu), { viewColumn: vscode.ViewColumn.Two, preview: false });
    await sleep(6000);
    assert.strictEqual(api._state().running, true);
    const textTab = group.tabs.find((t) => t.input instanceof vscode.TabInputText);
    await vscode.window.tabGroups.close(textTab);
    await until(() => previewVisible(vscode.ViewColumn.Two), 'browser tab back');
  });

  await step('closing the preview stops the server', async () => {
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === vscode.ViewColumn.Two);
    await vscode.window.tabGroups.close(group.activeTab);
    await until(() => !api._state().running, 'stopped');
    await assert.rejects(new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, resolve).on('error', reject);
    }));
  });

  await step('stop command leaves nothing running', async () => {
    const r = await vscode.commands.executeCommand('clickJump.open', vscode.Uri.file(index));
    assert.ok(r.port);
    await vscode.commands.executeCommand('clickJump.stop');
    assert.strictEqual(api._state().running, false);
  });

  await step('no window became visible during the run', async () => {
    const st = await control({ op: 'state' });
    assert.ok(st.every((w) => !w.visible), JSON.stringify(st));
  });

  const failed = results.filter((r) => !r[1]).length;
  console.log(`\nvscode: ${results.length} checks, ${results.length - failed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} VS Code checks failed`);
}

module.exports = { run };
