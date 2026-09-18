const { test } = require('node:test');
const assert = require('node:assert/strict');

// Own temp data dir, before any lib require: see test/helpers/temp-data-dir.js.
require('./helpers/temp-data-dir');

const { detect, block, blocks, effective, fallbackFor, rungOf, LADDER } = require('../lib/models');
const store = require('../lib/store');

function withBlocks(fn) {
  const before = store.state.settings.modelBlocks;
  store.state.settings.modelBlocks = {};
  try {
    fn();
  } finally {
    store.state.settings.modelBlocks = before;
  }
}

// --- detect() message matrix --------------------------------------------

test('detect: model-specific limit/unavailable/capacity phrasings for each named model', () => {
  for (const m of ['fable', 'opus', 'sonnet', 'haiku']) {
    assert.ok(detect(`${m} capacity limit reached`), m);
    assert.ok(detect(`${m} is currently unavailable`), m);
    assert.ok(detect(`${m}: not available right now`), m);
  }
});

test('detect: generic "model ... unavailable/not supported/no access" phrasing', () => {
  assert.ok(detect('model unavailable in this region'));
  assert.ok(detect('this model is not supported'));
  assert.ok(detect('model: no access'));
});

test('detect: overload / 529 phrasings', () => {
  assert.ok(detect('overloaded_error: please retry'));
  assert.ok(detect('status 529'));
  assert.ok(detect('HTTP 529 received'));
});

// 2026-09-10 batch defect: the CLI's wording for an unknown/inaccessible
// model id doesn't contain "unavailable"/"not supported"/"no access", so it
// slipped past detect() and the card landed in review with a raw CLI error
// instead of falling down the model ladder.
test('detect: "may not exist" model-id wording (the exact CLI sentence) is caught', () => {
  assert.ok(detect(
    "There's an issue with the selected model (cc/claude-sonnet-5). It may not exist or you may not have access to it."
  ));
  assert.ok(detect('model claude-opus-9 may not exist'));
  assert.ok(detect('no such model: claude-haiku-1'));
});

test('detect: generic subscription/usage limit text is NOT a model-specific failure', () => {
  assert.ok(!detect('usage limit reached'));
  assert.ok(!detect("you've hit your session limit"));
});

test('detect: unrelated errors and empty input return false', () => {
  assert.ok(!detect('some unrelated network error'));
  assert.ok(!detect(''));
  assert.ok(!detect(null));
  assert.ok(!detect(undefined));
});

// --- blocks() expiry + block() ---------------------------------------------

test('blocks() prunes expired entries and leaves live ones', () => {
  withBlocks(() => {
    store.state.settings.modelBlocks = { sonnet: Date.now() - 1000, opus: Date.now() + 60_000 };
    const b = blocks();
    assert.deepEqual(Object.keys(b), ['opus']);
  });
});

test('block() ignores "default" and models outside the ladder', () => {
  withBlocks(() => {
    block('default', 'x');
    block('gpt-4', 'x');
    assert.deepEqual(blocks(), {});
  });
});

test('block(): overload/529 errors get a 10-minute block, other failures 30 minutes', () => {
  withBlocks(() => {
    const before = Date.now();
    block('sonnet', 'overloaded_error');
    const until1 = blocks().sonnet;
    assert.ok(until1 > before + 9 * 60_000 && until1 <= before + 10 * 60_000 + 1000);

    block('opus', 'capacity limit reached');
    const until2 = blocks().opus;
    assert.ok(until2 > before + 29 * 60_000 && until2 <= before + 30 * 60_000 + 1000);
  });
});

// --- effective() ladder walking ---------------------------------------------

test('effective(): "default" or falsy model passes through untouched', () => {
  withBlocks(() => {
    assert.equal(effective('default'), 'default');
    assert.equal(effective(null), null);
    assert.equal(effective(''), '');
  });
});

test('effective(): no blocks means the requested model is returned as-is', () => {
  withBlocks(() => {
    assert.equal(effective('opus'), 'opus');
  });
});

test('effective(): walks down the ladder past multiple consecutive blocks', () => {
  withBlocks(() => {
    store.state.settings.modelBlocks = { opus: Date.now() + 60_000, sonnet: Date.now() + 60_000 };
    assert.equal(effective('opus'), 'haiku'); // opus -> sonnet (blocked) -> haiku (free)
  });
});

test('effective(): stops at haiku even if haiku is blocked (bottom of the ladder)', () => {
  withBlocks(() => {
    store.state.settings.modelBlocks = { haiku: Date.now() + 60_000 };
    assert.equal(effective('haiku'), 'haiku');
  });
});

test('effective(): a model not on the ladder is returned unchanged (indexOf -1 short-circuits)', () => {
  withBlocks(() => {
    assert.equal(effective('gpt-4'), 'gpt-4');
  });
});

// --- fallbackFor() -----------------------------------------------------------

test('fallbackFor: blocks the model matched as a substring of the full modelUsed id, then falls to the next rung', () => {
  withBlocks(() => {
    const task = { model: 'sonnet', modelUsed: 'claude-3-5-sonnet-20241022' };
    const next = fallbackFor(task, 'sonnet capacity limit reached');
    assert.equal(next, 'haiku');
    assert.ok(blocks().sonnet);
  });
});

test('fallbackFor: falls back to task.model when modelUsed does not name a ladder model', () => {
  withBlocks(() => {
    const task = { model: 'opus', modelUsed: null };
    const next = fallbackFor(task, 'capacity limit reached');
    assert.equal(next, 'sonnet');
  });
});

test('fallbackFor: returns null when neither modelUsed nor task.model names a ladder model', () => {
  withBlocks(() => {
    const task = { model: 'default', modelUsed: null };
    assert.equal(fallbackFor(task, 'some error'), null);
  });
});

test('fallbackFor: returns null at the bottom of the ladder (nowhere lower to go)', () => {
  withBlocks(() => {
    const task = { model: 'haiku', modelUsed: 'claude-haiku' };
    assert.equal(fallbackFor(task, 'haiku capacity limit reached'), null);
  });
});

test('fallbackFor: task.model === "default" still falls back using the failed model itself as the starting rung', () => {
  withBlocks(() => {
    const task = { model: 'default', modelUsed: 'claude-3-opus-20240229' };
    const next = fallbackFor(task, 'opus capacity limit reached');
    assert.equal(next, 'sonnet');
  });
});

test('LADDER is the documented fable -> opus -> sonnet -> haiku order', () => {
  assert.deepEqual(LADDER, ['fable', 'opus', 'sonnet', 'haiku']);
});

// --- full model ids map onto their ladder rung (2026-09-10 batch defect) ----
// A card set to a full model id like "claude-sonnet-4-5" (settable via
// PATCH /api/tasks/:id, not just the board's short-alias dropdown) used to
// never fall back: block()/effective() only recognized the 4 short names.

test('rungOf: maps a full model id onto the ladder rung it names, case-insensitively', () => {
  assert.equal(rungOf('claude-sonnet-4-5'), 'sonnet');
  assert.equal(rungOf('claude-3-5-haiku-20241022'), 'haiku');
  assert.equal(rungOf('CLAUDE-OPUS-4-1'), 'opus');
  assert.equal(rungOf('fable'), 'fable');
});

test('rungOf: returns null for "default", falsy, and ids naming no ladder rung', () => {
  assert.equal(rungOf('default'), null);
  assert.equal(rungOf(null), null);
  assert.equal(rungOf(''), null);
  assert.equal(rungOf('gpt-4'), null);
});

test('block(): a full model id blocks the rung it names, not the literal id', () => {
  withBlocks(() => {
    block('claude-sonnet-4-5', 'capacity limit reached');
    assert.deepEqual(Object.keys(blocks()), ['sonnet']);
  });
});

test('effective(): a full model id keeps its exact value when its rung is not blocked', () => {
  withBlocks(() => {
    assert.equal(effective('claude-sonnet-4-5'), 'claude-sonnet-4-5');
  });
});

test('effective(): a full model id steps down the ladder when its rung is blocked', () => {
  withBlocks(() => {
    store.state.settings.modelBlocks = { sonnet: Date.now() + 60_000 };
    assert.equal(effective('claude-sonnet-4-5'), 'haiku');
  });
});

test('fallbackFor: a card set to a full model id (not just a short alias) falls back down the ladder', () => {
  withBlocks(() => {
    const task = { model: 'claude-sonnet-4-5', modelUsed: null };
    const next = fallbackFor(task, 'sonnet capacity limit reached');
    assert.equal(next, 'haiku');
    assert.ok(blocks().sonnet);
  });
});
