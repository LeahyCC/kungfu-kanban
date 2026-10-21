/* mdInline: inline code inside link text. Regression for #66, where the code
 * span was stashed first, so the link captured its placeholder and the
 * stash lookup never resolved it, leaving a literal \x01N\x01 in the output. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let mdToHtml;

test.before(async () => {
  ({ mdToHtml } = await import('../public/js/markdown.js'));
});

test('inline code inside link text renders the code, not a placeholder', () => {
  const html = mdToHtml('see [`run_task`](https://example.com/docs)');

  assert.doesNotMatch(html, /\x01/, 'no leftover stash placeholder');
  assert.match(html, /<a href="https:\/\/example\.com\/docs"[^>]*><code>run_task<\/code><\/a>/);
});

test('code and link alongside each other still both resolve', () => {
  const html = mdToHtml('[one](https://a.test) and `two`');

  assert.doesNotMatch(html, /\x01/);
  assert.match(html, /<a href="https:\/\/a\.test"[^>]*>one<\/a>/);
  assert.match(html, /<code>two<\/code>/);
});
