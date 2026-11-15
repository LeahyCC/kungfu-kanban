// Follow-ups sent while a card runs used to get 409 "task is running", so the
// lead of a batch had to wait and resend. Now the HTTP route queues them on
// the card and they go out, in order, when the run ends. Also the opt-in
// resume of cards a board restart cut short. Only the claude spawn is faked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const cp = require('child_process');

const realSpawn = cp.spawn;
const children = [];
cp.spawn = (cmd, args, opts) => {
  if (cmd !== 'claude') return realSpawn(cmd, args, opts);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.prompt = '';
  child.stdin = { on() {}, write(s) { child.prompt += s; }, end(s) { if (s) child.prompt += s; } };
  child.args = args;
  child.pid = 99990 + children.length;
  child.kill = () => {};
  child.unref = () => {};
  children.push(child);
  return child;
};

require('./helpers/temp-data-dir');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;
store.state.settings.maxRunMinutes = 0;
store.state.settings.maxConcurrent = 4;
const runner = require('../lib/runner');

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-fq-'));
let n = 0;

beforeEach(() => {
  store.state.tasks.length = 0;
  children.length = 0;
  delete store.state.settings.resumeInterrupted;
});

async function until(fn) {
  for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fn(), 'condition never became true');
}

function card(extra) {
  const t = { id: `fq${String(++n).padStart(6, '0')}-1111`, title: 'c', prompt: 'p', cwd: CWD, status: 'backlog', ...extra };
  store.state.tasks.unshift(t);
  return t;
}

// Start a card and let its fake agent report a session id.
async function running(extra) {
  const t = card(extra);
  runner.startTask(t.id);
  await until(() => children.length === 1);
  children[0].stdout.emit('data', `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm' })}\n`);
  return { t, child: children[0] };
}

test('a follow-up sent while the card runs is queued, not refused', async () => {
  const { t, child } = await running();
  assert.deepEqual(runner.followUp(t.id, 'board code'), { error: 'task is running' }, 'board callers still get the refusal');
  const r = runner.followUp(t.id, 'also fix the footer', { queue: true });
  assert.deepEqual(r, { queued: true, afterRun: true, waiting: 1 });
  assert.equal(t.queuedFollowUps.length, 1);
  assert.equal(t.queuedFollowUps[0].message, 'also fix the footer');
  child.emit('close', 0);
  await until(() => children.length === 2);
  children[1].emit('close', 0);
  await until(() => t.status === 'review');
});

test('queued follow-ups are delivered together, in order, when the run ends', async () => {
  const { t, child } = await running();
  runner.followUp(t.id, 'first', { queue: true });
  runner.followUp(t.id, 'second', { queue: true });
  child.emit('close', 0);
  await until(() => children.length === 2);
  const resume = children[1];
  assert.deepEqual(resume.args.slice(0, 2), ['-r', 'sess-1'], 'resumes the same session');
  assert.ok(resume.prompt.startsWith('first\n\nsecond'));
  assert.equal(t.queuedFollowUps, null, 'cleared once sent');
  resume.emit('close', 0);
  await until(() => t.status === 'review');
});

test('a stopped run still delivers what was queued', async () => {
  const { t, child } = await running();
  runner.followUp(t.id, 'after the stop', { queue: true });
  runner.stopTask(t.id);
  child.emit('close', null);
  await until(() => children.length === 2);
  assert.ok(children[1].prompt.startsWith('after the stop'));
  children[1].emit('close', 0);
  await until(() => t.status === 'review');
});

test('queued follow-ups can be cleared', async () => {
  const { t, child } = await running();
  runner.followUp(t.id, 'never mind', { queue: true });
  assert.deepEqual(runner.clearQueuedFollowUps(t.id), { cleared: 1 });
  // null, not undefined: the board merges slim SSE payloads into its copy, so
  // a deleted field stayed on screen after "clear" (seen in a browser check).
  assert.strictEqual(t.queuedFollowUps, null);
  child.emit('close', 0);
  await until(() => t.status === 'review');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(children.length, 1, 'nothing resumed');
});

test('two follow-ups for a card waiting on a slot are both kept (the second used to overwrite the first)', async () => {
  store.state.settings.maxConcurrent = 1;
  try {
    const { child: busy } = await running(); // holds the only slot
    const t = card({ status: 'review', sessionId: 'sess-2' });
    runner.followUp(t.id, 'one');
    runner.followUp(t.id, 'two');
    assert.equal(t.status, 'queued');
    assert.equal(t.pendingFollowUp, 'one\n\ntwo');
    busy.emit('close', 0);
    await until(() => children.length === 2);
    assert.ok(children[1].prompt.startsWith('one\n\ntwo'));
    children[1].emit('close', 0);
    await until(() => t.status === 'review');
  } finally {
    store.state.settings.maxConcurrent = 4;
  }
});

test('boot: resumeInterrupted on resumes a cut-short card once', async () => {
  store.state.settings.resumeInterrupted = true;
  const t = card({ status: 'review', error: 'interrupted by server restart', interruptedRun: true, sessionId: 'sess-3' });
  runner.resumeAfterRestart();
  await until(() => children.length === 1);
  assert.deepEqual(children[0].args.slice(0, 2), ['-r', 'sess-3']);
  assert.ok(children[0].prompt.startsWith(runner.RESUME_NOTE));
  assert.equal(t.interruptedRun, undefined);
  children[0].emit('close', 0);
  await until(() => t.status === 'review');
});

test('boot: resumeInterrupted off clears the flag and resumes nothing', async () => {
  const t = card({ status: 'review', error: 'interrupted by server restart', interruptedRun: true, sessionId: 'sess-4' });
  runner.resumeAfterRestart();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(children.length, 0);
  assert.equal(t.interruptedRun, undefined, 'turning the setting on later will not resume this card');
});

test('boot: follow-ups queued before a restart are delivered', async () => {
  const t = card({ status: 'review', sessionId: 'sess-5', queuedFollowUps: [{ message: 'queued before the crash', at: 'x', counts: true }] });
  runner.resumeAfterRestart();
  await until(() => children.length === 1);
  assert.ok(children[0].prompt.startsWith('queued before the crash'));
  children[0].emit('close', 0);
  await until(() => t.status === 'review');
});

test('stopAll flags the run for the next boot', async () => {
  const { t, child } = await running();
  runner.stopAll();
  assert.equal(t.interruptedRun, true);
  child.emit('close', null);
  await until(() => !runner.isRunning(t.id));
});
