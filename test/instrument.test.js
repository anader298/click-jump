'use strict';
const test = require('node:test');
const assert = require('node:assert');
const parse5 = require('parse5');
const { instrument, encodeLoc, decodeLoc, SKIP } = require('../src/core/instrument');

const tagged = (src, rel = 'a.html', opts) => instrument(src, rel, opts).body.toString('utf8');
const ATTR = / data-cj="[^"]*"/g;
const locs = (html) => [...html.matchAll(/data-cj="([^"]*)"/g)].map((m) => decodeLoc(m[1]));

/** Text at a 1-based line/col, using the same line rules editors use. */
function at(src, line, col) {
  const lines = src.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  return lines[line - 1].slice(col - 1);
}

// Every generated location must point at the `<` of a tag with the right name.
function assertLocsPointAtTags(src, out) {
  for (const m of out.matchAll(/<([a-zA-Z][^\s/>]*) data-cj="([^"]*)"/g)) {
    const loc = decodeLoc(m[2]);
    const there = at(src, loc.line, loc.col);
    assert.ok(there.toLowerCase().startsWith(`<${m[1].toLowerCase()}`), `expected <${m[1]} at ${loc.line}:${loc.col}, found ${there.slice(0, 20)}`);
  }
}

// Strongest check: a real WHATWG parser must see the same document, apart from our attribute.
function assertSameDom(src) {
  const out = tagged(src);
  assert.strictEqual(out.replace(ATTR, ''), src.replace(/^﻿/, ''), 'only data-cj may differ');
  const a = parse5.serialize(parse5.parse(src, { scriptingEnabled: true }));
  const b = parse5.serialize(parse5.parse(out, { scriptingEnabled: true })).replace(/ data-cj="[^"]*"/g, '');
  assert.strictEqual(b, a);
  assertLocsPointAtTags(src, out);
}

// Every element parse5 finds (outside the skip list) must be tagged at its exact position.
function assertMatchesParse5(src) {
  const out = tagged(src);
  const ours = new Set(locs(out).map((l) => `${l.line}:${l.col}`));
  const doc = parse5.parse(src, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  const walk = (node) => {
    if (node.tagName && !SKIP.has(node.tagName) && node.sourceCodeLocation) {
      const l = node.sourceCodeLocation.startTag || node.sourceCodeLocation;
      assert.ok(ours.has(`${l.startLine}:${l.startCol}`), `missing <${node.tagName}> at ${l.startLine}:${l.startCol}`);
    }
    (node.childNodes || []).forEach(walk);
    if (node.content) walk(node.content);
  };
  walk(doc);
}

const corpus = {
  lf: '<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n<h1>Hi</h1>\n<p>a</p>\n</body>\n</html>\n',
  crlf: '<!doctype html>\r\n<html>\r\n<body>\r\n<h1>Hi</h1>\r\n<p\r\n  class="x">a</p>\r\n</body>\r\n</html>\r\n',
  'multi-line tag': '<body>\n<div\n  id="a"\n  class="b"\n>\n  <span\n    title="x"\n  >y</span>\n</div>\n</body>',
  '> in attributes': '<body><a title="1 > 0" data-x=\'<b>\' href=x>y</a><p>z</p></body>',
  'unquoted attributes': '<body><a href=/a/b.html class=c>x</a><img src=a.png alt=b><p>z</p></body>',
  comments: '<body><!-- <div>no</div> --><p>a</p><!-- multi\nline <p> --><span>b</span></body>',
  'raw content': '<head><title><b>t</b></title><style>p>a{color:red}</style><script>var a="<p>";</script></head><body><textarea><div>x</div></textarea><p>y</p></body>',
  template: '<body><template id="t"><div class="c"><span>x</span></div></template><p>y</p></body>',
  svg: '<body><svg viewBox="0 0 10 10"><title>Icon</title><g><circle r="1"/><path d="M0 0"/></g><foreignObject><div>x</div></foreignObject></svg><p>y</p></body>',
  uppercase: '<!DOCTYPE HTML><HTML><BODY><DIV CLASS="A"><P>x</P></DIV></BODY></HTML>',
  unicode: '<body>\n<p>Café 🍰 <b>bold</b> 日本語 <i>x</i></p>\n<a href="ü">😀</a></body>',
  'no body': '<h1>Hi</h1>\n<p>there</p>\n',
  'no doctype': '<p>one<p>two<div>three',
  malformed: '<div><p>a<span>b</div></p><table><tr><td>c<div>d</table><b><i>e</b></i>',
  'text with <': '<body><p>1 < 2 && 3 > 2</p><p>a<b</p></body>',
  'details and forms': '<body><details><summary>s</summary><p>x</p></details><select><option>a</select><form><input><button>b</button></form></body>',
  table: '<table><caption>c</caption><thead><tr><th>h</tr></thead><tbody><tr><td>d</td></tr></tbody></table>',
  'nested inline': '<p><a href="#"><strong><em>deep</em></strong></a></p>',
  'custom elements': '<my-app><my-card title="a>b"><p>x</p></my-card></my-app>',
  'boolean and empty attrs': '<input disabled value="" checked><button disabled>x</button>',
};

for (const [name, src] of Object.entries(corpus)) {
  test(`instrument same DOM: ${name}`, () => assertSameDom(src));
  test(`instrument matches parse5 positions: ${name}`, () => assertMatchesParse5(src));
}

test('a source data-cj attribute loses to ours and the DOM is otherwise intact', () => {
  const out = tagged('<div data-cj="mine" id="k">x</div>');
  const div = parse5.parse(out).childNodes[0].childNodes[1].childNodes[0];
  assert.strictEqual(div.attrs.find((a) => a.name === 'data-cj').value, 'a.html:1:1');
  assert.strictEqual(div.attrs.find((a) => a.name === 'id').value, 'k');
});

test('CRLF lines count once', () => {
  const src = '<a></a>\r\n<b></b>\r\n\r\n<i></i>';
  assert.deepStrictEqual(locs(tagged(src)).map((l) => [l.line, l.col]), [[1, 1], [2, 1], [4, 1]]);
});

test('lone CR counts as a line break', () => {
  assert.deepStrictEqual(locs(tagged('<a></a>\r<b></b>')).map((l) => l.line), [1, 2]);
});

test('mixed line endings', () => {
  assert.deepStrictEqual(locs(tagged('<a></a>\n<b></b>\r\n<i></i>\r<u></u>')).map((l) => l.line), [1, 2, 3, 4]);
});

test('column counts UTF-16 units so it matches VS Code', () => {
  const [, b] = locs(tagged('<p>🍰<b>x</b></p>'));
  assert.strictEqual(b.col, 6);
});

test('UTF-8 BOM does not shift the first line column', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>x</p>')]);
  const out = instrument(buf, 'a.html').body.toString('utf8');
  assert.deepStrictEqual(locs(out)[0], { rel: 'a.html', line: 1, col: 1 });
});

test('UTF-16 file is decoded and served as UTF-8', () => {
  const body = Buffer.from('﻿<p>café</p>', 'utf16le');
  const r = instrument(body, 'a.html');
  assert.strictEqual(r.charset, 'utf-8');
  assert.ok(r.body.toString('utf8').includes('café'));
});

test('legacy Latin-1 bytes pass through unchanged', () => {
  const src = Buffer.from('<meta charset="iso-8859-1"><p>caf\xe9</p>', 'latin1');
  const r = instrument(src, 'a.html');
  assert.strictEqual(r.charset, null);
  assert.ok(r.body.includes(Buffer.from('caf\xe9', 'latin1')));
});

test('input buffer is not mutated', () => {
  const buf = Buffer.from(corpus.lf);
  const copy = Buffer.from(buf);
  instrument(buf, 'a.html', { clientTag: '<script></script>' });
  assert.ok(buf.equals(copy));
});

test('filenames with spaces, quotes and unicode round-trip', () => {
  for (const rel of ['my page.html', 'it\'s "x".html', 'café/🍰.html', 'a:b.html', 'a&b<c>.html', '100%.html']) {
    const out = tagged('<p>x</p>', rel);
    assert.strictEqual(locs(out)[0].rel, rel);
    assert.strictEqual(parse5.serialize(parse5.parse(out)).includes('<p data-cj='), true);
  }
});

test('encodeLoc output is attribute-safe', () => {
  assert.ok(!/["<>&\s]/.test(encodeLoc('a "b" <c>&.html', 1, 1)));
});

test('decodeLoc rejects malformed input', () => {
  for (const bad of ['', 'a', 'a:1', 'a:x:1', 'a:0:1', 'a:1:0', ':1:1', 'a:1:1:1', '%zz:1:1', 5, null, {}, `${'a'.repeat(3000)}:1:1`]) {
    assert.strictEqual(decodeLoc(bad), null, String(bad));
  }
});

test('client goes after doctype and inside head', () => {
  const out = tagged('<!doctype html><html><head><title>x</title></head><body></body></html>', 'a.html', { clientTag: '<script id=c></script>' });
  assert.ok(out.includes('<head><script id=c></script><title>'));
});

test('client with no head goes after <html>', () => {
  const out = tagged('<!doctype html><html><body><p>x</p></body></html>', 'a.html', { clientTag: '<script id=c></script>' });
  assert.ok(out.includes('<html><script id=c></script><body'));
});

test('client with no html goes after the doctype, keeping standards mode', () => {
  const out = tagged('<!doctype html><p>x</p>', 'a.html', { clientTag: '<script id=c></script>' });
  assert.ok(out.startsWith('<!doctype html><script id=c></script><p'));
  assert.strictEqual(parse5.parse(out).mode, 'no-quirks');
});

test('client lands in a document with no tags at all', () => {
  assert.ok(tagged('just text', 'a.html', { clientTag: '<script id=c></script>' }).includes('<script id=c>'));
  assert.strictEqual(tagged('', 'a.html', { clientTag: '<i></i>' }), '<i></i>');
});

test('huge file (about 20 MB) stays linear', () => {
  const row = '<div class="row"><span title="a>b">cell</span><!-- c --></div>\n';
  const src = row.repeat(Math.ceil(20e6 / row.length));
  const t0 = Date.now();
  const r = instrument(src, 'big.html');
  const ms = Date.now() - t0;
  assert.strictEqual(r.tags, src.split('\n').length * 2 - 2);
  assert.ok(ms < 15000, `took ${ms} ms`);
});

test('pathological < runs stay fast', () => {
  const t0 = Date.now();
  instrument('<'.repeat(2e6), 'a.html');
  instrument('<a '.repeat(5e5), 'a.html');
  instrument('<!--'.repeat(5e5), 'a.html');
  instrument(`<script>${'<!--<script>'.repeat(2e5)}`, 'a.html');
  assert.ok(Date.now() - t0 < 10000);
});

// Seeded fuzz: stitch hostile fragments together and check the invariants.
test('fuzz: 3000 random documents keep the DOM and positions', () => {
  const parts = ['<div>', '</div>', '<p class="a>b">', '</p>', '<span title=\'<x>\'>', '</span>', '<!-- c -->', '<!--', '-->',
    '<script>', '</script>', '<style>', '</style>', '<textarea>', '</textarea>', '<title>', '</title>', '<svg>', '</svg>',
    '<math>', '</math>', '<foreignObject>', '</foreignObject>', '<template>', '</template>', '<table>', '<tr>', '<td>',
    '</table>', '<br/>', '<img src=x>', '<a href=y>', '</a>', 'text', '\n', '\r\n', ' < ', '>', '"', "'", '&amp;', '🍰',
    '<![CDATA[', ']]>', '<!x>', '<?y?>', '</ z>', '<noscript>', '</noscript>', '<select>', '<option>', '</select>', '<b>', '<i>', '</b>'];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let d = 0; d < 3000; d++) {
    let s = '';
    const len = 1 + rnd(25);
    for (let k = 0; k < len; k++) s += parts[rnd(parts.length)];
    try {
      assertSameDom(s);
      // Parsers disagree on raw-text tags inside <select> since customizable
      // select landed. We treat them as raw, so positions are only compared
      // without a <select>. The DOM check above still covers those documents.
      if (!s.includes('<select>')) assertMatchesParse5(s);
    } catch (err) {
      err.message = `doc ${d}: ${JSON.stringify(s)}\n${err.message}`;
      throw err;
    }
  }
});
