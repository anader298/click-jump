'use strict';
// A small HTML tokenizer that follows the WHATWG tokenizer states closely
// enough to know where every real start tag begins. It does not build a tree.
// It tracks just enough context (SVG/MathML, raw-text elements) to avoid
// mistaking text for tags.

const RAW_TEXT = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title']);
const SVG_INTEGRATION = new Set(['foreignobject', 'desc', 'title']);
const MATH_INTEGRATION = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']);
// HTML start tags that force the parser out of foreign content.
const BREAKOUT = new Set(['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt',
  'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta',
  'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u',
  'ul', 'var']);

function isSpace(c) { return c === 32 || c === 10 || c === 9 || c === 13 || c === 12; }
function isLetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }

// Reads attributes from just after the tag name. Returns the index after `>`,
// or -1 when the input ends inside the tag (browsers drop such a tag).
function scanAttributes(s, from) {
  const n = s.length;
  let i = from;
  let selfClosing = false;
  while (i < n) {
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    if (i >= n) return { end: -1, selfClosing };
    const c = s.charCodeAt(i);
    if (c === 62) return { end: i + 1, selfClosing };
    if (c === 47) {
      if (s.charCodeAt(i + 1) === 62) return { end: i + 2, selfClosing: true };
      i++;
      continue;
    }
    // Attribute name. A leading `=` is part of the name per spec.
    i++;
    while (i < n) {
      const a = s.charCodeAt(i);
      if (isSpace(a) || a === 47 || a === 62 || a === 61) break;
      i++;
    }
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) !== 61) continue;
    i++;
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    if (i >= n) return { end: -1, selfClosing };
    const q = s.charCodeAt(i);
    if (q === 34 || q === 39) {
      const close = s.indexOf(q === 34 ? '"' : "'", i + 1);
      if (close < 0) return { end: -1, selfClosing };
      i = close + 1;
    } else if (q !== 62) {
      while (i < n) {
        const a = s.charCodeAt(i);
        if (isSpace(a) || a === 62) break;
        i++;
      }
    }
  }
  return { end: -1, selfClosing };
}

function matchesEndTag(s, i, name) {
  // s[i] is '<' and s[i+1] is '/'
  const stop = i + 2 + name.length;
  if (stop > s.length) return false;
  for (let k = 0; k < name.length; k++) {
    if ((s.charCodeAt(i + 2 + k) | 32) !== name.charCodeAt(k)) return false;
  }
  if (stop === s.length) return false;
  const c = s.charCodeAt(stop);
  return isSpace(c) || c === 47 || c === 62;
}

function findRawEnd(s, from, name) {
  let i = from;
  for (;;) {
    i = s.indexOf('</', i);
    if (i < 0) return s.length;
    if (matchesEndTag(s, i, name)) return i;
    i += 2;
  }
}

// Script content has its own escape rules: inside `<!-- <script>` a `</script>`
// does not close the element.
function findScriptEnd(s, from) {
  const n = s.length;
  let state = 0; // 0 data, 1 escaped, 2 double escaped
  let i = from;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 45 && state > 0 && s.startsWith('-->', i)) {
      state = 0;
      i += 3;
    } else if (c === 60) {
      if (state === 0 && s.startsWith('<!--', i)) {
        state = 1;
        i += 2; // leave `--` so `<!-->` closes the escape at once
      } else if (s.charCodeAt(i + 1) === 47 && matchesEndTag(s, i, 'script')) {
        if (state === 2) {
          state = 1;
          i += 8;
        } else {
          return i;
        }
      } else if (state === 1 && s.slice(i + 1, i + 7).toLowerCase() === 'script') {
        const after = s.charCodeAt(i + 7);
        if (isSpace(after) || after === 47 || after === 62) state = 2;
        i += 7;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return n;
}

function commentEnd(s, i) {
  const j = i + 4;
  if (s.charCodeAt(j) === 62) return j + 1;
  if (s.startsWith('->', j)) return j + 2;
  // One forward scan. Searching for each closer separately is quadratic when
  // a file has many comments and never uses the rarer `--!>`.
  for (let k = s.indexOf('--', j); k >= 0; k = s.indexOf('--', k + 1)) {
    const c = s.charCodeAt(k + 2);
    if (c === 62) return k + 3;
    if (c === 33 && s.charCodeAt(k + 3) === 62) return k + 4;
  }
  return s.length;
}

function bogusEnd(s, i) {
  const close = s.indexOf('>', i);
  return close < 0 ? s.length : close + 1;
}

/**
 * Calls onToken for every start tag, end tag, comment and doctype.
 * Start tags are { type, name, start, nameEnd, end, selfClosing, foreign }.
 */
function tokenize(s, onToken) {
  const n = s.length;
  const ctx = []; // foreign-content stack: { name, foreign }
  const inForeign = () => ctx.length > 0 && ctx[ctx.length - 1].foreign;
  let i = 0;

  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    const c1 = s.charCodeAt(i + 1);

    if (c1 === 33) { // <!
      if (s.startsWith('<!--', i)) {
        const end = commentEnd(s, i);
        onToken({ type: 'comment', start: i, end });
        i = end;
      } else if (inForeign() && s.startsWith('<![CDATA[', i)) {
        const close = s.indexOf(']]>', i + 9);
        i = close < 0 ? n : close + 3;
      } else {
        const end = bogusEnd(s, i);
        const isDoctype = s.slice(i + 2, i + 9).toLowerCase() === 'doctype';
        onToken({ type: isDoctype ? 'doctype' : 'comment', start: i, end });
        i = end;
      }
      continue;
    }
    if (c1 === 63) { // <?
      i = bogusEnd(s, i);
      continue;
    }
    if (c1 === 47) { // </
      const c2 = s.charCodeAt(i + 2);
      if (c2 === 62) { i += 3; continue; }
      if (!isLetter(c2)) {
        if (i + 2 >= n) break;
        i = bogusEnd(s, i);
        continue;
      }
      let k = i + 2;
      while (k < n) {
        const a = s.charCodeAt(k);
        if (isSpace(a) || a === 47 || a === 62) break;
        k++;
      }
      const name = s.slice(i + 2, k).toLowerCase();
      const { end } = scanAttributes(s, k);
      if (end < 0) break;
      if (ctx.length && ctx[ctx.length - 1].name === name) ctx.pop();
      onToken({ type: 'end', name, start: i, end });
      i = end;
      continue;
    }
    if (!isLetter(c1)) { i++; continue; }

    // Start tag
    let k = i + 1;
    while (k < n) {
      const a = s.charCodeAt(k);
      if (isSpace(a) || a === 47 || a === 62) break;
      k++;
    }
    const name = s.slice(i + 1, k).toLowerCase();
    const { end, selfClosing } = scanAttributes(s, k);
    if (end < 0) break;

    if (inForeign() && BREAKOUT.has(name)) {
      while (inForeign()) ctx.pop();
    }
    const foreign = inForeign();
    onToken({ type: 'start', name, start: i, nameEnd: k, end, selfClosing, foreign });
    i = end;

    if (foreign) {
      const top = ctx[ctx.length - 1].name;
      if (selfClosing) continue;
      if (name === 'svg' || name === 'math') ctx.push({ name, foreign: true });
      else if (top === 'svg' && SVG_INTEGRATION.has(name)) ctx.push({ name, foreign: false });
      else if (top === 'math' && MATH_INTEGRATION.has(name)) ctx.push({ name, foreign: false });
      continue;
    }
    if (name === 'svg' || name === 'math') {
      if (!selfClosing) ctx.push({ name, foreign: true });
      continue;
    }
    if (name === 'script') {
      i = findScriptEnd(s, i);
    } else if (name === 'plaintext') {
      i = n;
    } else if (RAW_TEXT.has(name)) {
      i = findRawEnd(s, i, name);
    }
  }
}

module.exports = { tokenize };
