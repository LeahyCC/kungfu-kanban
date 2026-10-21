// The card badge shows one entry per contract name, at its newest version.
// state.js is browser ESM with no DOM access, so it imports straight into node.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('latestPublished keeps the newest version per name, in first-published order', async () => {
  const { latestPublished } = await import('../public/js/state.js');
  const rec = (name, version) => ({ name, version, sha256: 'x', publishedAt: 't' });
  const task = { published: [rec('api', 1), rec('schema', 1), rec('api', 3), rec('api', 2)] };
  assert.deepEqual(latestPublished(task).map((p) => `${p.name} v${p.version}`), ['api v3', 'schema v1']);
});

test('latestPublished copes with a card that published nothing or has odd data', async () => {
  const { latestPublished } = await import('../public/js/state.js');
  assert.deepEqual(latestPublished({}), []);
  assert.deepEqual(latestPublished(null), []);
  assert.deepEqual(latestPublished({ published: 'nope' }), []);
  assert.deepEqual(latestPublished({ published: [null, { version: 1 }] }), []);
});
