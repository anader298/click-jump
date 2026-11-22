'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tokenize } = require('../src/core/tokenizer');

const starts = (s) => {
  const out = [];
  tokenize(s, (t) => { if (t.type === 'start') out.push(t.name); });
  return out;
};

const cases = [
  ['simple', '<div><p>x</p></div>', ['div', 'p']],
  ['uppercase', '<DIV><SpAn>x</SPAN></DIV>', ['div', 'span']],
  ['> in double quotes', '<a title="a>b"><i>x</i></a>', ['a', 'i']],
  ["> in single quotes", "<a title='a>b'><i>x</i></a>", ['a', 'i']],
  ['unquoted attr', '<a href=/x/y.html class=b><i></i></a>', ['a', 'i']],
  ['unquoted with slash then >', '<a href=foo/><b></b>', ['a', 'b']],
  ['empty attr value then >', '<a href=><b></b>', ['a', 'b']],
  ['attr spaces around =', '<a href = "x>y" ><b></b></a>', ['a', 'b']],
  ['multi-line tag', '<div\n  class="a"\n  id="b"\n><p></p></div>', ['div', 'p']],
  ['comment hides tags', '<!-- <div> --><p></p>', ['p']],
  ['comment --!> close', '<!-- x --!><p></p>', ['p']],
  ['abrupt comment <!-->', '<!--><p></p>', ['p']],
  ['abrupt comment <!--->', '<!---><p></p>', ['p']],
  ['unterminated comment', '<p></p><!-- <div>', ['p']],
  ['bogus comment', '<!foo <div> ><p></p>', ['p']],
  ['processing instruction', '<?php echo "x" ?><p></p>', ['p']],
  ['script content', '<script>if (a<b) "<div>"</script><p></p>', ['script', 'p']],
  ['script end tag case', '<script>x</SCRIPT ><p></p>', ['script', 'p']],
  ['script double escape', '<script><!-- <script> </script> --></script><p></p>', ['script', 'p']],
  ['script escaped closes', '<script><!-- x </script><p></p>', ['script', 'p']],
  ['script <!--> closes escape', '<script><!--><script></script><p></p>', ['script', 'p']],
  ['style content', '<style>a>b{content:"<div>"}</style><p></p>', ['style', 'p']],
  ['textarea content', '<textarea><div></textarea><p></p>', ['textarea', 'p']],
  ['title content', '<title><div></title><p></p>', ['title', 'p']],
  ['xmp content', '<xmp><div></xmp><p></p>', ['xmp', 'p']],
  ['iframe content', '<iframe><div></iframe><p></p>', ['iframe', 'p']],
  ['noscript content', '<noscript><div></noscript><p></p>', ['noscript', 'p']],
  ['plaintext', '<plaintext><div></div>', ['plaintext']],
  ['near end tag in raw', '<textarea></textareax><div></textarea><p></p>', ['textarea', 'p']],
  ['svg title is not raw', '<svg><title><g></g></title></svg><p></p>', ['svg', 'title', 'g', 'p']],
  ['svg script is not raw', '<svg><script><g></g></script></svg>', ['svg', 'script', 'g']],
  ['svg style is not raw', '<svg><style><g></g></style></svg>', ['svg', 'style', 'g']],
  ['cdata in svg', '<svg><![CDATA[<div>]]><g></g></svg>', ['svg', 'g']],
  ['cdata in html is bogus', '<![CDATA[<div>]]><p></p>', ['p']],
  ['foreignObject returns to html', '<svg><foreignObject><textarea><b></textarea></foreignObject></svg>', ['svg', 'foreignobject', 'textarea']],
  ['html breakout from svg', '<svg><div><textarea><b></textarea></div>', ['svg', 'div', 'textarea']],
  ['self-closed svg', '<svg/><textarea><b></textarea>', ['svg', 'textarea']],
  ['math text integration', '<math><mi><textarea><b></textarea></mi></math>', ['math', 'mi', 'textarea']],
  ['less-than in text', '<p>1 < 2 and 3 <4</p><b></b>', ['p', 'b']],
  ['lone < at end', '<p></p><', ['p']],
  ['tag cut off at EOF', '<p></p><div class="a', ['p']],
  ['end tag with attrs', '</div class="<p>"><b></b>', ['b']],
  ['empty end tag', '</><p></p>', ['p']],
  ['bogus end tag', '</ <div>><p></p>', ['p']],
  ['custom element', '<my-card data-x=1><slot></slot></my-card>', ['my-card', 'slot']],
  ['template content is tokenized', '<template><div></div></template>', ['template', 'div']],
  ['slash in tag', '<br/><img src=a /><hr / >', ['br', 'img', 'hr']],
  ['duplicate attrs', '<a x=1 x=2 x="><b>"><i></i></a>', ['a', 'i']],
  ['equals first in attr name', '<a =x="y>"><b></b></a>', ['a', 'b']],
];

for (const [name, input, expected] of cases) {
  test(`tokenizer: ${name}`, () => assert.deepStrictEqual(starts(input), expected));
}
