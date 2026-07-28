const { test } = require('node:test');
const assert = require('node:assert/strict');

// util.js has no top-level DOM access, so the ES module imports cleanly here.
test('fuzzyScore ranks prefix > substring > subsequence > miss', async () => {
  const { fuzzyScore } = await import('../public/js/util.js');
  assert.equal(fuzzyScore('new', 'new card'), 3);
  assert.equal(fuzzyScore('card', 'new card'), 2);
  assert.equal(fuzzyScore('ncd', 'new card'), 1); // n…c…d in order
  assert.equal(fuzzyScore('xyz', 'new card'), 0);
  assert.equal(fuzzyScore('dcn', 'new card'), 0); // out of order ≠ match
  assert.equal(fuzzyScore('', 'anything'), 1); // empty query shows all
});
