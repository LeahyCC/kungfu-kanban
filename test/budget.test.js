const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isOver, active } = require('../lib/budget');
const { state } = require('../lib/store');

// Pure decision matrix — the same formula the ⛽ chip renders, so the gate
// and the meter can never disagree. hit()/clear() are exercised only via the
// live-server checklist: in-process they fire real notifications (cooldown
// and offline tests set the same pure-surface precedent).

test('isOver: unset or zero budget never blocks', () => {
  assert.equal(isOver(0, 0), false);
  assert.equal(isOver(5_000_000, 0), false);
  assert.equal(isOver(5_000_000, undefined), false);
});

test('isOver: below, exactly at, and above the budget', () => {
  assert.equal(isOver(999_999, 1_000_000), false);
  assert.equal(isOver(1_000_000, 1_000_000), true); // spent == budget blocks
  assert.equal(isOver(1_000_001, 1_000_000), true);
});

test('isOver: missing usage reads as zero', () => {
  assert.equal(isOver(undefined, 1_000_000), false);
  assert.equal(isOver(null, 1_000_000), false);
});

test('active: no budget configured → false, no scan side effects', () => {
  const prev = state.settings.usageBudgetTokens;
  state.settings.usageBudgetTokens = 0;
  try {
    assert.equal(active(), false);
  } finally {
    state.settings.usageBudgetTokens = prev;
  }
});
