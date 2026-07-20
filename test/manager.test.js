const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
const { executeAction, suggestionLive } = require('../lib/manager');

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

// --- suggestionLive: a suggestion dies once its target card has moved past
// the state where approving it would actually do anything ---------------

test('suggestionLive: run_task goes dead once the card has already run', () => {
  const task = { id: 'ran', status: 'done' };
  store.state.tasks.push(task);
  try {
    const s = { action: { type: 'run_task', taskId: task.id } };
    assert.equal(suggestionLive(s), false);
    task.status = 'backlog';
    assert.equal(suggestionLive(s), true);
    task.status = 'queued';
    assert.equal(suggestionLive(s), true);
  } finally {
    store.state.tasks.length = store.state.tasks.length - 1;
  }
});

test('suggestionLive: review-gated actions die once the card leaves review', () => {
  const task = { id: 'reviewed', status: 'review' };
  store.state.tasks.push(task);
  try {
    for (const type of ['approve_task', 'reject_task', 'merge_pr', 'followup_task']) {
      const s = { action: { type, taskId: task.id } };
      assert.equal(suggestionLive(s), true, type);
    }
    task.status = 'done';
    for (const type of ['approve_task', 'reject_task', 'merge_pr', 'followup_task']) {
      const s = { action: { type, taskId: task.id } };
      assert.equal(suggestionLive(s), false, type);
    }
  } finally {
    store.state.tasks.length = store.state.tasks.length - 1;
  }
});

test('suggestionLive: a deleted/archived target card is always dead', () => {
  const s = { action: { type: 'run_task', taskId: 'does-not-exist' } };
  assert.equal(suggestionLive(s), false);
});

test('suggestionLive: card-less actions (create_task, resolve_error) are always live', () => {
  assert.equal(suggestionLive({ action: { type: 'create_task' } }), true);
  assert.equal(suggestionLive({ action: { type: 'resolve_error', errorId: 'x' } }), true);
});
