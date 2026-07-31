// Isolate persistence BEFORE requiring lib/* — this file previously ran
// against the checkout's real data/, appending fake 'merged PR of "undefined"'
// entries to data/manager-log.jsonl on every test run.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-mgr-test-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
const { executeAction, heldForApproval, suggestionLive, stopCurrent, SEMI_HELD } = require('../lib/manager');

// --- stopCurrent -------------------------------------------------------

test('stopCurrent: errors cleanly when no Sensei run is in flight', () => {
  assert.deepEqual(stopCurrent(), { error: 'the Sensei is not running' });
});

// --- autonomy ladder + per-action release ------------------------------

test('autonomy ladder: suggest holds everything, auto holds nothing', () => {
  const none = { approve_task: false, reject_task: false, followup_task: false, merge_pr: false };
  for (const type of [...SEMI_HELD, 'create_task', 'run_task']) {
    assert.equal(heldForApproval(type, { autonomy: 'suggest', autoActions: none }), true, `suggest holds ${type}`);
    assert.equal(heldForApproval(type, { autonomy: 'auto', autoActions: none }), false, `auto releases ${type}`);
  }
});

test('semi holds the four verdicts by default and releases only what is ticked', () => {
  const none = { approve_task: false, reject_task: false, followup_task: false, merge_pr: false };
  const semi = (autoActions) => (type) => heldForApproval(type, { autonomy: 'semi', autoActions });

  const classic = semi(none);
  for (const type of SEMI_HELD) assert.equal(classic(type), true, `${type} held by default`);
  assert.equal(classic('run_task'), false, 'semi still dispatches work on its own');

  // the case the bundled gate could not express: merge green PRs, ask before approving
  const mergeOnly = semi({ ...none, merge_pr: true });
  assert.equal(mergeOnly('merge_pr'), false, 'merge released');
  assert.equal(mergeOnly('approve_task'), true, 'approve still held');
  assert.equal(mergeOnly('reject_task'), true, 'reject still held');

  // ticking everything is 'auto' for verdicts, without granting it board-wide
  const all = semi({ approve_task: true, reject_task: true, followup_task: true, merge_pr: true });
  for (const type of SEMI_HELD) assert.equal(all(type), false, `${type} released`);
});

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
    [{ id: 'conflicting', status: 'review', prUrl: 'https://x', prChecks: { base: 'main', passing: 1, failing: 0, pending: 0, conflicting: true } }, false, false], // green CI but merge conflicts

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

test('merge_pr: a no-CI repo past the grace window IS mergeable on diff review alone', async () => {
  const prflow = require('../lib/prflow');
  const realMerge = prflow.mergePr;
  let merged = null;
  prflow.mergePr = async (t) => { merged = t.id; return { ok: true }; };
  const task = { id: 'no-ci-ok', status: 'review', prUrl: 'https://x', prChecks: { base: 'main', passing: 0, failing: 0, pending: 0, noCi: true } };
  store.state.tasks.push(task);
  try {
    const res = executeAction({ type: 'merge_pr', taskId: task.id, reasoning: 'diff satisfies criteria' });
    assert.equal(res.error, undefined);
    assert.equal(res.note, undefined, 'must actually merge, not hold');
    await new Promise((r) => setImmediate(r)); // mergePr resolves async
    assert.equal(merged, task.id);
  } finally {
    prflow.mergePr = realMerge;
    store.state.tasks.length = store.state.tasks.length - 1;
  }
});

test('requeue_task: running and stopping cards are successful no-ops', () => {
  for (const status of ['running', 'stopping']) {
    const task = { id: `requeue-${status}`, status, prompt: 'original prompt' };
    store.state.tasks.push(task);
    try {
      const res = executeAction({
        type: 'requeue_task',
        taskId: task.id,
        feedback: 'should not be appended',
        reasoning: 'test',
      });
      assert.equal(res.error, undefined, status);
      assert.equal(res.ok, true, status);
      assert.equal(task.status, status);
      assert.equal(task.prompt, 'original prompt');
    } finally {
      store.state.tasks.length = store.state.tasks.length - 1;
    }
  }
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
