// Injected into the served copy of each page. Plain ES5-style so it runs anywhere.
(function () {
  'use strict';
  if (window.__clickJumpLoaded) return;
  window.__clickJumpLoaded = true;

  var script = document.currentScript;
  var token = script && script.getAttribute('data-cj-token');
  if (!token) return;
  // Absolute URLs: a <base href> in the page must not redirect our requests.
  var origin = location.origin;

  var gesture = false;      // true from an Option+press until its click ends
  var gestureTimer = 0;
  var altHeld = false;
  var hovered = null;
  var lastLoc = '';
  var lastAt = 0;
  var overlay = null;
  var label = null;

  function css(el, rules) {
    for (var k in rules) el.style.setProperty(k, rules[k], 'important');
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-cj-overlay', '');
    css(overlay, {
      all: 'initial', position: 'fixed', 'z-index': '2147483647', 'pointer-events': 'none', display: 'none',
      outline: '2px solid #2f80ed', background: 'rgba(47,128,237,.14)', 'box-sizing': 'border-box'
    });
    label = document.createElement('div');
    css(label, {
      all: 'initial', position: 'absolute', left: '0', bottom: '100%', 'pointer-events': 'none',
      background: '#2f80ed', color: '#fff', font: '11px/16px ui-monospace,Menlo,Consolas,monospace',
      padding: '1px 5px', 'white-space': 'nowrap', 'max-width': '60vw', overflow: 'hidden', 'text-overflow': 'ellipsis'
    });
    overlay.appendChild(label);
  }

  function locOf(el) {
    var loc = el.getAttribute('data-cj') || '';
    var parts = loc.split(':');
    var file = parts[0] || '';
    try { file = decodeURIComponent(file); } catch (e) { /* show it raw */ }
    return file + ':' + (parts[1] || '');
  }

  function paint() {
    if (!altHeld || !hovered || !hovered.isConnected) {
      if (overlay) overlay.style.setProperty('display', 'none', 'important');
      return;
    }
    ensureOverlay();
    if (!overlay.isConnected) document.documentElement.appendChild(overlay);
    var r = hovered.getBoundingClientRect();
    css(overlay, {
      display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'
    });
    label.textContent = locOf(hovered);
    // Keep the label on screen for elements at the very top.
    if (r.top < 20) css(label, { bottom: 'auto', top: '0' });
    else css(label, { top: 'auto', bottom: '100%' });
  }

  function findTarget(e) {
    var path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.nodeType === 1 && n.hasAttribute('data-cj')) return n;
    }
    var t = e.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    return t && t.closest ? t.closest('[data-cj]') : null;
  }

  function sendJump(el) {
    var loc = el.getAttribute('data-cj');
    var now = Date.now();
    if (loc === lastLoc && now - lastAt < 350) return; // double click, one jump
    lastLoc = loc;
    lastAt = now;
    fetch(origin + '/__cj/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CJ-Token': token },
      body: JSON.stringify({ loc: loc }),
      keepalive: true,
      credentials: 'omit'
    }).catch(function () { /* the server may have stopped */ });
    if (overlay) {
      overlay.style.setProperty('background', 'rgba(255,196,0,.35)', 'important');
      setTimeout(function () {
        if (overlay) overlay.style.setProperty('background', 'rgba(47,128,237,.14)', 'important');
      }, 220);
    }
  }

  function swallow(e) {
    if (e.cancelable && e.type !== 'pointerdown') e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function endGestureSoon() {
    clearTimeout(gestureTimer);
    gestureTimer = setTimeout(function () { gesture = false; }, 300);
  }

  function isJumpPress(e) {
    return e.isTrusted !== false && e.altKey && e.button === 0 && !e.ctrlKey && !e.metaKey;
  }

  // pointerdown is deliberately not default-prevented: cancelling it would
  // suppress the mousedown we need to cancel for text selection and drag.
  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (!isJumpPress(e)) { gesture = false; return; }
    var el = findTarget(e);
    if (!el) return;
    clearTimeout(gestureTimer);
    gesture = true;
    swallow(e);
    sendJump(el);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (gesture) { swallow(e); return; }
    if (!isJumpPress(e)) return;
    var el = findTarget(e);
    if (!el) return;
    gesture = true;
    swallow(e);
    sendJump(el);
  }

  function onRelease(e) {
    if (!gesture) return;
    swallow(e);
    if (e.type === 'mouseup' || e.type === 'pointerup') endGestureSoon();
  }

  function onClick(e) {
    if (gesture) {
      swallow(e);
      clearTimeout(gestureTimer);
      gesture = false;
      return;
    }
    // A click with no press seen (some WebKit paths). detail 0 means keyboard.
    if (isJumpPress(e) && e.detail > 0) {
      var el = findTarget(e);
      if (el) { swallow(e); sendJump(el); }
    }
  }

  function onSuppressible(e) {
    if (gesture) swallow(e);
  }

  function setAlt(v) {
    if (altHeld === v) return;
    altHeld = v;
    paint();
  }

  function reset() {
    gesture = false;
    clearTimeout(gestureTimer);
    setAlt(false);
  }

  var opts = { capture: true };
  window.addEventListener('pointerdown', onPointerDown, opts);
  window.addEventListener('mousedown', onMouseDown, opts);
  window.addEventListener('pointerup', onRelease, opts);
  window.addEventListener('mouseup', onRelease, opts);
  window.addEventListener('click', onClick, opts);
  window.addEventListener('auxclick', onSuppressible, opts);
  window.addEventListener('dblclick', onSuppressible, opts);
  window.addEventListener('dragstart', onSuppressible, opts);
  window.addEventListener('selectstart', onSuppressible, opts);

  window.addEventListener('keydown', function (e) { if (e.key === 'Alt') setAlt(true); }, opts);
  window.addEventListener('keyup', function (e) { if (e.key === 'Alt') setAlt(false); }, opts);
  // The keyup is lost if Option is released in another app or window.
  window.addEventListener('blur', reset, opts);
  window.addEventListener('pagehide', reset, opts);
  document.addEventListener('visibilitychange', function () { if (document.hidden) reset(); }, opts);

  window.addEventListener('mousemove', function (e) {
    altHeld = e.altKey;
    hovered = altHeld ? findTarget(e) : null;
    paint();
  }, { capture: true, passive: true });
  window.addEventListener('scroll', function () { if (altHeld) paint(); }, { capture: true, passive: true });
  document.documentElement.addEventListener('mouseleave', function () { hovered = null; paint(); });

  // Live reload
  var version = null;
  function connect() {
    var es = new EventSource(origin + '/__cj/events?token=' + encodeURIComponent(token));
    es.addEventListener('hello', function (e) {
      if (version !== null && e.data !== version) location.reload();
      version = e.data;
    });
    es.addEventListener('reload', function () { location.reload(); });
    window.addEventListener('pagehide', function () { es.close(); });
  }
  connect();
})();
