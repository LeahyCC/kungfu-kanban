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
const { executeAction, heldForApproval, suggestionLive, stopCurrent, finishInvocation, SEMI_HELD } = require('../lib/manager');
const errlog = require('../lib/errlog');
const { setStatus } = require('../lib/transitions');

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

test('suggestionLive: create_task has no card to go stale, so it stays live', () => {
  assert.equal(suggestionLive({ action: { type: 'create_task' } }), true);
});

test('suggestionLive: resolve_error dies once its error is resolved or gone', () => {
  const e = errlog.capture('run-failed', { text: 'suggestionLive resolve_error probe' });
  const s = { action: { type: 'resolve_error', errorId: e.id } };
  assert.equal(suggestionLive(s), true);
  errlog.resolve(e.id, 'human');
  assert.equal(suggestionLive(s), false, 'resolved');
  assert.equal(suggestionLive({ action: { type: 'resolve_error', errorId: 'never-existed' } }), false, 'unknown id');
});

test('suggestionLive: update_task and retarget_pr die once the card is done', () => {
  const task = { id: 'upd-done', status: 'review' };
  store.state.tasks.push(task);
  try {
    for (const type of ['update_task', 'retarget_pr']) {
      assert.equal(suggestionLive({ action: { type, taskId: task.id } }), true, `${type} live in review`);
    }
    task.status = 'done';
    for (const type of ['update_task', 'retarget_pr']) {
      assert.equal(suggestionLive({ action: { type, taskId: task.id } }), false, `${type} dead when done`);
    }
  } finally {
    store.state.tasks.length = store.state.tasks.length - 1;
  }
});

test('suggestionLive: retarget_pr dies once the PR is merged or closed, even before the card is done', () => {
  const task = { id: 'retarget-moot', status: 'review', prUrl: 'https://x' };
  store.state.tasks.push(task);
  try {
    const s = { action: { type: 'retarget_pr', taskId: task.id } };
    assert.equal(suggestionLive(s), true);
    task.prClosedNoted = true;
    assert.equal(suggestionLive(s), false, 'closed');
    delete task.prClosedNoted;
    task.prMergedAt = new Date().toISOString();
    assert.equal(suggestionLive(s), false, 'merged');
  } finally {
    store.state.tasks.length = store.state.tasks.length - 1;
  }
});

// --- Sensei run errors clear on the next clean run -----------------------

test('a clean Sensei run resolves earlier run-level Sensei errors, not failed actions', () => {
  const runErr = errlog.capture('sensei', { text: 'Manager run errored: boom' });
  const unparsable = errlog.capture('sensei', { text: 'Manager output unparsable (x): y' });
  const actionErr = errlog.capture('sensei', { text: 'create "a" — failed: nope' });
  const cardErr = errlog.capture('run-failed', { text: 'a card failed' });
  finishInvocation(JSON.stringify({ result: JSON.stringify({ actions: [] }) }), '', 'test', false);
  const open = (id) => errlog.isOpen(id);
  assert.equal(open(runErr.id), false);
  assert.equal(open(unparsable.id), false);
  assert.equal(open(actionErr.id), true, 'a failed action is not fixed by a clean run');
  assert.equal(open(cardErr.id), true, 'other kinds are untouched');
});

test('a Sensei run that errors again does not resolve its own earlier errors', () => {
  const runErr = errlog.capture('sensei', { text: 'Manager run errored: still broken' });
  finishInvocation(JSON.stringify({ is_error: true, result: 'still broken' }), '', 'test', false);
  assert.equal(errlog.isOpen(runErr.id), true);
});

// --- pruning is event-driven, not only on page load -----------------------

const tick = () => new Promise((r) => setImmediate(r));

// Seed a suggestion the way the Sensei does (autonomy defaults to 'suggest'),
// and read manager.json from disk: publicState() prunes on its own, which would
// mask whether the event-driven prune ran.
function suggest(action) {
  finishInvocation(JSON.stringify({ result: JSON.stringify({ actions: [action] }) }), '', 'test', false);
}
function persistedActions() {
  return JSON.parse(fs.readFileSync(path.join(process.env.KFK_DATA_DIR, 'manager.json'), 'utf8')).suggestions.map((s) => s.action);
}

test('resolving an error prunes its resolve_error suggestion without a page load', async () => {
  const e = errlog.capture('run-failed', { text: 'event-driven prune probe' });
  suggest({ type: 'resolve_error', errorId: e.id, reasoning: 'test' });
  assert.ok(persistedActions().some((a) => a.errorId === e.id), 'seeded');
  errlog.resolve(e.id, 'auto');
  await tick();
  assert.equal(persistedActions().some((a) => a.errorId === e.id), false);
});

test('a card changing status prunes its suggestions without a page load', async () => {
  const task = { id: 'status-prune', status: 'review' };
  store.state.tasks.push(task);
  try {
    suggest({ type: 'approve_task', taskId: task.id, reasoning: 'test' });
    assert.ok(persistedActions().some((a) => a.taskId === task.id), 'seeded');
    setStatus(task, 'done');
    await tick();
    assert.equal(persistedActions().some((a) => a.taskId === task.id), false);
  } finally {
    store.state.tasks.length = store.state.tasks.length - 1;
  }
});
