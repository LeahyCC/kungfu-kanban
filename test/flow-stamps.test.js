// Flow facts stamped on a card as it moves (queuedAt, doneAt, followUps,
// sendBacks), recorded by lib/transitions.js and fed by the runner and the
// Sensei's actions. They are the "before" numbers for card contracts, so the
// counting rules matter: a follow-up is not also a send-back, and the runner
// re-parking a card for a cooldown is not a send-back at all.
//
// child_process.spawn is stubbed BEFORE lib/runner loads (it destructures
// spawn at require time), the same way runner-followup-resume.test.js does.
const { EventEmitter } = require('events');
const cp = require('child_process');

cp.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 99998;
  child.kill = () => {};
  child.unref = () => {};
  return child;
};

// Own temp data dir, before any lib require: see test/helpers/temp-data-dir.js.
require('./helpers/temp-data-dir');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;
// The stubbed child never closes; a live watchdog timer would hold the
// process open after the tests finish.
store.state.settings.maxRunMinutes = 0;

const { setStatus, countFollowUp } = require('../lib/transitions');
const runner = require('../lib/runner');
const manager = require('../lib/manager');

function card(id, overrides) {
  const task = { id, title: id, status: 'backlog', deps: [], prompt: 'p', sessionId: 'sess', ...overrides };
  store.state.tasks.push(task);
  return task;
}

// --- setStatus ---------------------------------------------------------------

test('setStatus: entering queued stamps queuedAt, and each later entry overwrites it', async () => {
  const t = { status: 'backlog' };
  const before = Date.now();
  setStatus(t, 'queued');
  assert.equal(t.status, 'queued');
  assert.ok(Date.parse(t.queuedAt) >= before, 'stamped with the current time');
  const first = t.queuedAt;
  setStatus(t, 'review');
  await new Promise((r) => setTimeout(r, 5));
  setStatus(t, 'queued');
  assert.notEqual(t.queuedAt, first, 'latest queue entry wins');
});

test('setStatus: entering done stamps doneAt; setting the same status again changes nothing', () => {
  const t = { status: 'review' };
  setStatus(t, 'done');
  assert.ok(t.doneAt);
  const stamped = t.doneAt;
  // The PR watcher re-asserts done on a card a human already approved.
  setStatus(t, 'done');
  assert.equal(t.doneAt, stamped);
  assert.equal(t.sendBacks, undefined);
});

test('setStatus: other statuses stamp neither time', () => {
  const t = { status: 'backlog' };
  setStatus(t, 'review');
  assert.equal(t.queuedAt, undefined);
  assert.equal(t.doneAt, undefined);
});

test('setStatus: sendBacks counts review or done going back to queued or running, and only those', () => {
  const back = [['review', 'queued'], ['review', 'running'], ['done', 'queued'], ['done', 'running']];
  for (const [from, to] of back) {
    const t = { status: from };
    setStatus(t, to);
    assert.equal(t.sendBacks, 1, `${from} -> ${to}`);
  }
  const notBack = [['backlog', 'queued'], ['queued', 'running'], ['running', 'review'], ['running', 'queued'],
    ['stopping', 'review'], ['review', 'done'], ['review', 'backlog']];
  for (const [from, to] of notBack) {
    const t = { status: from };
    setStatus(t, to);
    assert.equal(t.sendBacks, undefined, `${from} -> ${to}`);
  }
});

test('setStatus: { sendBack: false } skips the count but still stamps queuedAt', () => {
  const t = { status: 'review', sendBacks: 2 };
  setStatus(t, 'queued', { sendBack: false });
  assert.equal(t.sendBacks, 2);
  assert.ok(t.queuedAt);
});

test('countFollowUp starts from a card that lacks the field', () => {
  const t = {};
  countFollowUp(t);
  countFollowUp(t);
  assert.equal(t.followUps, 2);
});

// --- runner ------------------------------------------------------------------

test('runner.followUp: counts a follow-up, not a send-back, and the card ends up running', () => {
  const t = card('fu-1', { status: 'review' });
  const res = runner.followUp('fu-1', 'fix the typo');
  assert.ok(res.started || res.queued);
  assert.equal(t.followUps, 1);
  assert.equal(t.sendBacks, undefined);
  assert.ok(['running', 'queued'].includes(t.status), t.status); // queued when the run slots are full
  assert.ok(t.queuedAt, 'it passed through queued on the way');
});

test('runner.followUp: a refused follow-up (no session) counts nothing', () => {
  const t = card('fu-2', { status: 'review', sessionId: null });
  assert.ok(runner.followUp('fu-2', 'x').error);
  assert.equal(t.followUps, undefined);
});

test('runner.startTask: running a review card again is a send-back', () => {
  const t = card('rerun-1', { status: 'review', sessionId: null });
  runner.startTask('rerun-1');
  assert.ok(['running', 'queued'].includes(t.status), t.status); // queued when the run slots are full
  assert.equal(t.sendBacks, 1);
});

test('runner.startTask: a first run from backlog is not a send-back', () => {
  const t = card('first-1', { status: 'backlog', sessionId: null });
  runner.startTask('first-1');
  assert.ok(['running', 'queued'].includes(t.status), t.status); // queued when the run slots are full
  assert.equal(t.sendBacks, undefined);
});

// --- Sensei actions ----------------------------------------------------------

test('Sensei followup_task: counts a follow-up', () => {
  const t = card('sensei-fu', { status: 'review' });
  manager.executeAction({ type: 'followup_task', taskId: 'sensei-fu', message: 'rename it' });
  assert.equal(t.followUps, 1);
  assert.equal(t.sendBacks, undefined);
});

test('Sensei reject_task: counts a send-back', () => {
  const t = card('sensei-rej', { status: 'review', sessionId: null });
  manager.executeAction({ type: 'reject_task', taskId: 'sensei-rej', feedback: 'try again' });
  assert.equal(t.sendBacks, 1);
  assert.equal(t.retries, 1);
});

test('Sensei approve_task stamps doneAt; requeue_task stamps queuedAt and counts a send-back', () => {
  const a = card('sensei-ok', { status: 'review' });
  manager.executeAction({ type: 'approve_task', taskId: 'sensei-ok' });
  assert.equal(a.status, 'done');
  assert.ok(a.doneAt);

  const r = card('sensei-rq', { status: 'review' });
  // A dep that never ships keeps the requeued card parked in queued.
  card('blocker', { status: 'backlog' });
  r.deps = ['blocker'];
  manager.executeAction({ type: 'requeue_task', taskId: 'sensei-rq' });
  assert.equal(r.status, 'queued');
  assert.ok(r.queuedAt);
  assert.equal(r.sendBacks, 1);
});
