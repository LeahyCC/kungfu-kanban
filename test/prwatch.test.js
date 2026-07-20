const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeChecks, trackChecks } = require('../lib/prwatch');
const errlog = require('../lib/errlog');

// --- summarizeChecks ----------------------------------------------------

test('summarizeChecks rolls up mixed CheckRun and StatusContext entries', () => {
  const out = summarizeChecks([
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'ci/old-fail', state: 'ERROR' },
    { __typename: 'StatusContext', context: 'ci/pending', state: 'PENDING' },
  ]);
  assert.equal(out.passing, 2);
  assert.equal(out.failing, 2);
  assert.equal(out.pending, 2);
  assert.deepEqual(out.failed, ['test', 'ci/old-fail']);
});

test('summarizeChecks handles an empty/missing rollup', () => {
  assert.deepEqual(summarizeChecks(null), { passing: 0, failing: 0, pending: 0, failed: [] });
  assert.deepEqual(summarizeChecks(undefined), { passing: 0, failing: 0, pending: 0, failed: [] });
  assert.deepEqual(summarizeChecks([]), { passing: 0, failing: 0, pending: 0, failed: [] });
});

test('summarizeChecks: CheckRun NEUTRAL/SKIPPED conclusions count as passing', () => {
  const out = summarizeChecks([
    { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'SKIPPED' },
  ]);
  assert.equal(out.passing, 2);
  assert.equal(out.failing, 0);
});

test('summarizeChecks: an unknown/unrecognized CheckRun conclusion counts as failing', () => {
  const out = summarizeChecks([{ __typename: 'CheckRun', name: 'weird', status: 'COMPLETED', conclusion: 'CANCELLED' }]);
  assert.equal(out.failing, 1);
  assert.deepEqual(out.failed, ['weird']);
});

test('summarizeChecks: a CheckRun not COMPLETED (any status) counts as pending', () => {
  const out = summarizeChecks([
    { __typename: 'CheckRun', name: 'q', status: 'QUEUED' },
    { __typename: 'CheckRun', name: 'w', status: 'WAITING' },
  ]);
  assert.equal(out.pending, 2);
  assert.equal(out.failing, 0);
});

test('summarizeChecks: an unrecognized StatusContext state counts as pending, not failing', () => {
  const out = summarizeChecks([{ __typename: 'StatusContext', context: 'legacy', state: 'EXPECTED' }]);
  assert.equal(out.pending, 1);
  assert.equal(out.failing, 0);
});

test('summarizeChecks: falls back to a generic "check" name when name/context is missing', () => {
  const out = summarizeChecks([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }]);
  assert.deepEqual(out.failed, ['check']);
});

test('summarizeChecks: failed list is capped at 5 entries', () => {
  const rollup = Array.from({ length: 8 }, (_, i) => ({
    __typename: 'CheckRun', name: `c${i}`, status: 'COMPLETED', conclusion: 'FAILURE',
  }));
  const out = summarizeChecks(rollup);
  assert.equal(out.failing, 8);
  assert.equal(out.failed.length, 5);
});

// --- trackChecks transitions (observed via state, not notifications) --------

function fakeTask(overrides = {}) {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    title: 'Fake card',
    status: 'review',
    prUrl: 'https://github.com/x/y/pull/1',
    ...overrides,
  };
}

test('trackChecks: first sweep stores prChecks with a key and base', () => {
  const t = fakeTask();
  trackChecks(t, { baseRefName: 'main', statusCheckRollup: [] });
  assert.ok(t.prChecks);
  assert.equal(t.prChecks.base, 'main');
  assert.equal(t.prChecks.passing, 0);
  assert.ok(t.prChecks.key);
});

test('trackChecks: an identical sweep (same key) is a no-op — at.timestamp does not change', () => {
  const t = fakeTask();
  const info = { baseRefName: 'main', statusCheckRollup: [{ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  trackChecks(t, info);
  const first = t.prChecks;
  trackChecks(t, info);
  assert.equal(t.prChecks, first); // same object reference — trackChecks returned before reassigning
});

test('trackChecks: a genuinely new failure updates prChecks and the failed list', () => {
  const t = fakeTask();
  try {
    trackChecks(t, { baseRefName: 'main', statusCheckRollup: [] });
    trackChecks(t, {
      baseRefName: 'main',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    assert.equal(t.prChecks.failing, 1);
    assert.deepEqual(t.prChecks.failed, ['build']);
  } finally {
    errlog.resolveTask(t.id); // the failure above auto-captures a 'ci-failing' entry
  }
});

test('trackChecks: wrongBase is set when the PR base drifts from the card\'s declared prBaseBranch', () => {
  const t = fakeTask({ prBaseBranch: 'staging' });
  try {
    trackChecks(t, { baseRefName: 'main', statusCheckRollup: [] });
    assert.equal(t.prChecks.wrongBase, true);
  } finally {
    errlog.resolveTask(t.id); // wrongBase auto-captures a 'wrong-base' entry
  }
});

test('trackChecks: wrongBase is false when the card never declared a prBaseBranch', () => {
  const t = fakeTask();
  trackChecks(t, { baseRefName: 'main', statusCheckRollup: [] });
  assert.equal(t.prChecks.wrongBase, false);
});

test('trackChecks: recovering from failing to all-green (no pending) resolves the ci-failing entry it auto-captured', () => {
  const t = fakeTask();
  try {
    // First sweep: a failing check — trackChecks itself captures a 'ci-failing' entry.
    trackChecks(t, {
      baseRefName: 'main',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    assert.equal(errlog.list().filter((e) => e.taskId === t.id && !e.resolved).length, 1);

    // Second sweep: all green — should auto-resolve what the first sweep captured.
    trackChecks(t, {
      baseRefName: 'main',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    assert.equal(t.prChecks.failing, 0);
    assert.equal(t.prChecks.pending, 0);
    assert.equal(errlog.list().filter((e) => e.taskId === t.id && !e.resolved).length, 0);
  } finally {
    errlog.resolveTask(t.id);
  }
});

test('trackChecks: repeated identical failures do not multiply store state — key stays stable across sweeps', () => {
  const t = fakeTask();
  try {
    const info = { baseRefName: 'main', statusCheckRollup: [{ __typename: 'CheckRun', name: 'flaky', status: 'COMPLETED', conclusion: 'FAILURE' }] };
    trackChecks(t, info);
    const key1 = t.prChecks.key;
    trackChecks(t, info);
    assert.equal(t.prChecks.key, key1);
  } finally {
    errlog.resolveTask(t.id);
  }
});
