const { test } = require('node:test');
const assert = require('node:assert/strict');

const { prBody, parseDuplicatePrUrl } = require('../lib/prflow');

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

// A card's own agent opening its own PR races the board's PR flow: gh
// refuses the duplicate but hands back the existing URL in the same
// message. That URL must be recoverable instead of leaving the card
// stranded with no prUrl (bouldi PRs #935-#937, 2026-07-28).
test('parseDuplicatePrUrl: extracts the URL from gh\'s duplicate-PR error', () => {
  const err = 'a pull request for branch "kanban-abc123" into branch "main" already exists: https://github.com/LeahyCC/bouldi/pull/935';
  assert.equal(parseDuplicatePrUrl(err), 'https://github.com/LeahyCC/bouldi/pull/935');
});

test('parseDuplicatePrUrl: other gh pr create failures return null', () => {
  assert.equal(parseDuplicatePrUrl('pull request create failed: GraphQL: Head sha can\'t be blank'), null);
  assert.equal(parseDuplicatePrUrl('HTTP 401: Bad credentials'), null);
});
