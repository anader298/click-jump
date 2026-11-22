'use strict';
const { tokenize } = require('./tokenizer');

// Elements with nothing to click on. Their children, if any, are still tagged.
const SKIP = new Set(['html', 'head', 'meta', 'link', 'title', 'base', 'script', 'style', 'noscript', 'template']);

/** Encodes a relative path so it is safe in an attribute and splits cleanly on `:`. */
function encodeLoc(relPath, line, col) {
  return `${relPath.split('/').map(encodeURIComponent).join('/')}:${line}:${col}`;
}

/** Reverses encodeLoc. Returns null for anything malformed. */
function decodeLoc(loc) {
  if (typeof loc !== 'string' || loc.length > 2048) return null;
  const m = /^([^:]+):(\d{1,9}):(\d{1,9})$/.exec(loc);
  if (!m) return null;
  let rel;
  try {
    rel = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const line = Number(m[2]);
  const col = Number(m[3]);
  if (line < 1 || col < 1) return null;
  return { rel, line, col };
}

function decodeSource(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8', 3), encoding: 'utf8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf8' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf8' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf), encoding: 'utf8' };
  } catch {
    // Legacy encoding: keep bytes 1:1 and let the page's own <meta charset> decide.
    return { text: buf.toString('latin1'), encoding: 'latin1' };
  }
}

/**
 * Returns a tagged copy of an HTML document. The input is never mutated.
 * @param {Buffer|string} source
 * @param {string} relPath posix path relative to the served root
 * @param {{clientTag?: string}} [options]
 */
function instrument(source, relPath, options = {}) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
  const { text, encoding } = decodeSource(buf);
  const clientTag = options.clientTag || '';

  const inserts = []; // { at, str } ascending
  let insertAt = 0;
  let headLocked = false; // true once a real content tag has been seen

  // Incremental line tracking: token offsets only ever grow.
  let line = 1;
  let lineStart = 0;
  let cursor = 0;
  const advance = (to) => {
    while (cursor < to) {
      const c = text.charCodeAt(cursor);
      if (c === 10) {
        line++;
        lineStart = cursor + 1;
      } else if (c === 13) {
        if (text.charCodeAt(cursor + 1) === 10) {
          if (cursor + 1 >= to) break; // stay before the \n of a split CRLF
          cursor++;
        }
        line++;
        lineStart = cursor + 1;
      }
      cursor++;
    }
  };

  let tags = 0;
  tokenize(text, (t) => {
    if (t.type === 'doctype') {
      if (!headLocked) insertAt = t.end;
      return;
    }
    if (t.type !== 'start') return;
    if (!headLocked) {
      if (t.name === 'html') insertAt = t.end;
      else if (t.name === 'head') {
        insertAt = t.end;
        headLocked = true;
      } else headLocked = true;
    }
    if (SKIP.has(t.name)) return;
    advance(t.start);
    const loc = encodeLoc(relPath, line, t.start - lineStart + 1);
    inserts.push({ at: t.nameEnd, str: ` data-cj="${loc}"` });
    tags++;
  });

  const parts = [];
  let prev = 0;
  let clientDone = !clientTag;
  for (const ins of inserts) {
    if (!clientDone && insertAt <= ins.at) {
      parts.push(text.slice(prev, insertAt), clientTag);
      prev = insertAt;
      clientDone = true;
    }
    parts.push(text.slice(prev, ins.at), ins.str);
    prev = ins.at;
  }
  if (!clientDone) {
    parts.push(text.slice(prev, insertAt), clientTag);
    prev = insertAt;
  }
  parts.push(text.slice(prev));
  const out = parts.join('');
  return {
    body: Buffer.from(out, encoding === 'latin1' ? 'latin1' : 'utf8'),
    charset: encoding === 'latin1' ? null : 'utf-8',
    tags,
  };
}

module.exports = { instrument, encodeLoc, decodeLoc, SKIP };
