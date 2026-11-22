// Test-only. Copied into a throwaway VS Code in a temp folder, never shipped.
// Replaces the `electron` import so no window can ever appear on the screen.
import electron from 'electron';
import fs from 'node:fs';
import http from 'node:http';

export * from 'electron';

const { app, dialog, shell } = electron;
const shown = [];

// A factory, not a subclass: Electron's getAllWindows() ignores subclasses, and
// VS Code uses that list to decide which frames may load its own files.
const RealWindow = electron.BrowserWindow;
function HiddenWindow(options = {}) {
  const win = new RealWindow({
    ...options,
    show: false,
    x: undefined,
    y: undefined,
    width: 1440,
    height: 860,
    fullscreen: false,
    webPreferences: { ...(options.webPreferences || {}), backgroundThrottling: false },
  });
  for (const name of ['show', 'showInactive']) win[name] = () => { shown.push(`${name} blocked`); };
  for (const name of ['focus', 'moveTop', 'maximize', 'setFullScreen', 'setSimpleFullScreen', 'setKiosk', 'flashFrame']) {
    win[name] = () => {};
  }
  win.webContents.once('did-finish-load', () => {
    try { win.webContents.incrementCapturerCount({ width: 1440, height: 860 }, true, true); } catch { /* older API */ }
  });
  return win;
}
HiddenWindow.prototype = RealWindow.prototype;
Object.setPrototypeOf(HiddenWindow, RealWindow);

const proxied = new Proxy(electron, {
  get(target, key) {
    if (key === 'BrowserWindow') return HiddenWindow;
    return Reflect.get(target, key);
  },
});
export default proxied;
export { HiddenWindow as BrowserWindow };

// Nothing may reach the user's desktop.
const quiet = (obj, name, value) => { try { obj[name] = value; } catch { /* read-only */ } };
quiet(app, 'focus', () => {});
quiet(app, 'setAsDefaultProtocolClient', () => false);
if (app.dock) { for (const m of ['show', 'bounce', 'setBadge']) quiet(app.dock, m, () => {}); try { app.dock.hide(); } catch { /* ignore */ } }
try { app.setActivationPolicy('prohibited'); } catch { /* not on this OS */ }
quiet(shell, 'openExternal', async () => {});
quiet(shell, 'openPath', async () => '');
quiet(shell, 'showItemInFolder', () => {});
quiet(dialog, 'showMessageBox', async () => ({ response: 0, checkboxChecked: false }));
quiet(dialog, 'showMessageBoxSync', () => 0);
quiet(dialog, 'showErrorBox', (title, body) => console.error('[dialog]', title, body));
quiet(dialog, 'showOpenDialog', async () => ({ canceled: true, filePaths: [] }));
quiet(dialog, 'showSaveDialog', async () => ({ canceled: true }));

function mainContents() {
  const win = electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('workbench'));
  if (!win) throw new Error('no workbench window');
  return win;
}

function frames(win) { return win.webContents.mainFrame.framesInSubtree; }

const captured = new WeakSet();

// The Integrated Browser is its own web contents; the fallback panel is an iframe.
function findTarget(part) {
  const win = mainContents();
  const frame = frames(win).find((x) => x.url.includes(part));
  if (frame) return { contents: win.webContents, frame };
  const view = electron.webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().includes(part));
  if (!view) throw new Error(`no page matching ${part}`);
  // In a hidden window a freshly navigated view stops taking input unless it counts as captured.
  if (!captured.has(view)) {
    captured.add(view);
    view.incrementCapturerCount({ width: 800, height: 800 }, true, true);
  }
  return { contents: view, frame: view.mainFrame };
}

// Sums iframe offsets from the top of the web contents down to the target frame.
async function frameOffset(frame) {
  let x = 0;
  let y = 0;
  for (let cur = frame; cur.parent; cur = cur.parent) {
    const r = await cur.parent.executeJavaScript(`(() => {
      const list = [...document.querySelectorAll('iframe')].map((f) => f.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
      list.sort((a, b) => b.width * b.height - a.width * a.height);
      return list[0] ? { x: list[0].left, y: list[0].top } : null;
    })()`);
    if (!r) throw new Error('frame has no visible iframe');
    x += r.x;
    y += r.y;
  }
  return { x, y };
}

// A fresh attach each time: after a navigation a hidden view drops input sent on the old session.
async function debuggerFor(contents) {
  const dbg = contents.debugger;
  if (dbg.isAttached()) dbg.detach();
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  return dbg;
}

const ops = {
  frames: async () => [
    ...frames(mainContents()).map((f) => f.url),
    ...electron.webContents.getAllWebContents().filter((c) => !c.isDestroyed()).map((c) => c.getURL()),
  ],
  state: async () => electron.BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() })),
  blocked: async () => shown.length,
  eval: async ({ part, code }) => findTarget(part).frame.executeJavaScript(code),
  altClick: async ({ part, selector, alt = true }) => {
    const { contents, frame } = findTarget(part);
    const box = await frame.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 40), y: b.top + b.height / 2 }; })()`);
    const off = await frameOffset(frame);
    const x = Math.round(box.x + off.x);
    const y = Math.round(box.y + off.y);
    // DevTools input reaches hidden windows and produces trusted events.
    const dbg = await debuggerFor(contents);
    const modifiers = alt ? 1 : 0;
    const send = (type, extra = {}) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, modifiers, ...extra });
    // A hidden view can drop input while it wakes up. Undelivered presses are safe to resend.
    await frame.executeJavaScript(`window.__cjPressed = 0; addEventListener('mousedown', () => { window.__cjPressed++; }, { capture: true, once: true }); 1`);
    for (let tries = 0; tries < 12; tries++) {
      await send('mouseMoved');
      await new Promise((r) => setTimeout(r, 60));
      await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 30));
      await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 120));
      if (await frame.executeJavaScript('window.__cjPressed')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { x, y };
  },
  hover: async ({ part, selector, alt = true }) => {
    const { contents, frame } = findTarget(part);
    const box = await frame.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 40), y: b.top + b.height / 2 }; })()`);
    const off = await frameOffset(frame);
    await (await debuggerFor(contents)).sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.x + off.x), y: Math.round(box.y + off.y), modifiers: alt ? 1 : 0 });
    return true;
  },
  // The browser is a native view that page captures leave out, so its pixels are laid over the workbench.
  capture: async ({ file }) => {
    const win = mainContents();
    const view = win.contentView.children.find((v) => v.webContents?.getURL().startsWith('http://127.0.0.1') && v.getVisible());
    if (view) {
      const shot = (await view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toDataURL();
      const b = view.getBounds();
      await win.webContents.executeJavaScript(`new Promise((done) => {
        const i = new Image(); i.id = 'cj-shot'; i.onload = done;
        i.style = 'position:fixed;z-index:99999;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px';
        i.src = ${JSON.stringify(shot)}; document.body.append(i);
      }).then(() => new Promise(requestAnimationFrame)).then(() => 1)`);
    }
    const img = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (view) await win.webContents.executeJavaScript(`document.getElementById('cj-shot').remove(); 1`);
    const png = img.toPNG();
    fs.writeFileSync(file, png);
    return { bytes: png.length, ...img.getSize() };
  },
};

if (process.env.CJ_CONTROL_FILE) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const value = await ops[body.op](body);
        res.end(JSON.stringify({ value: value === undefined ? null : value }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(process.env.CJ_CONTROL_FILE, String(server.address().port));
  });
  server.unref();
}
