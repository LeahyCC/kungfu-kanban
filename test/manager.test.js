const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
const { executeAction } = require('../lib/manager');

// --- executeAction merge_pr gates --------------------------------------

test('merge_pr holds on every unready state and never merges', () => {
  const cases = [
    // [task, expectError, expectStatusChanged]
    [{ id: 'no-pr', status: 'review' }, false, false],
    [{ id: 'no-checks', status: 'review', prUrl: 'https://x' }, false, false], // prChecks absent — unknown, not green
    [{ id: 'zero-checks', status: 'review', prUrl: 'https://x', prChecks: { base: 'main', passing: 0, failing: 0, pending: 0 } }, false, false], // rollup empty — unknown, not green
    [{ id: 'wrong-base', status: 'review', prUrl: 'https://x', prChecks: { base: 'main', failing: 0, pending: 0, wrongBase: true } }, false, false],
    [{ id: 'base-mismatch', status: 'review', prUrl: 'https://x', prBaseBranch: 'staging', prChecks: { base: 'main', failing: 0, pending: 0 } }, false, false],
    [{ id: 'failing', status: 'review', prUrl: 'https://x', prChecks: { base: 'main', failing: 1, pending: 0 } }, false, false],
    [{ id: 'pending', status: 'review', prUrl: 'https://x', prChecks: { base: 'main', failing: 0, pending: 1 } }, false, false],
    [{ id: 'already-done', status: 'done' }, false, false], // idempotent — success no-op, not an error
    [{ id: 'backlog', status: 'backlog' }, true, false],    // not in review at all
  ];
  for (const [task, expectError, expectStatusChanged] of cases) {
    const before = task.status;
    store.state.tasks.push(task);
    try {
      const res = executeAction({ type: 'merge_pr', taskId: task.id, reasoning: 'test' });
      assert.equal(!!res.error, expectError, `case ${task.id}`);
      assert.equal(task.status !== before, expectStatusChanged, `case ${task.id} should not change status`);
    } finally {
      store.state.tasks.length = store.state.tasks.length - 1;
    }
  }
});

test('merge_pr: an unknown taskId errors without touching state', () => {
  const res = executeAction({ type: 'merge_pr', taskId: 'does-not-exist', reasoning: 'test' });
  assert.ok(res.error);
});
