const { test } = require('node:test');
const assert = require('node:assert/strict');

const { prBody } = require('../lib/prflow');

// "Fixes #N" is the load-bearing line: it is what auto-closes an imported
// GitHub issue when the PR merges. Lock it against refactors.
test('prBody: imported-issue cards lead with the closing keyword', () => {
  const body = prBody({ issueNumber: 42, prompt: 'do the thing' });
  assert.match(body, /^Fixes #42\n/);
});

test('prBody: no issueNumber → no closing keyword', () => {
  const body = prBody({ prompt: 'do the thing' });
  assert.ok(!body.includes('Fixes #'));
});

test('prBody: footer credits the project in both shapes', () => {
  assert.match(prBody({ issueNumber: 7 }), /🥋 Opened by/);
  assert.match(prBody({}), /🥋 Opened by/);
});

test('prBody: prompt is truncated at 1500 chars', () => {
  const body = prBody({ prompt: 'x'.repeat(2000) });
  assert.ok(body.includes('x'.repeat(1500)));
  assert.ok(!body.includes('x'.repeat(1501)));
});
