// End of a worktree card's run: processes the agent left running (a `next dev`
// on :3123, say) are reaped and named on the card, before the run's slot
// frees. Seen on an ACE batch where dev servers held worktrees and ports until
// merge and outlived a board crash. Only the claude spawn and the reap are faked.
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
  child.stdin = { on() {}, write() {}, end() {} };
  child.pid = 99997;
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

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-reap-cwd-')); // not a repo: the pre-launch sync no-ops
let reaped;

beforeEach(() => {
  store.state.tasks.length = 0;
  children.length = 0;
  reaped = [];
  runner.reapRun = async (task) => {
    reaped.push({ id: task.id, runningDuringReap: runner.isRunning(task.id) });
    return { removed: [], problems: [], notes: ['killed process 5 (node.exe) running in the worktree'] };
  };
});

async function until(fn) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fn(), 'condition never became true');
}

function card(extra) {
  const t = { id: `reap${Math.random().toString(16).slice(2, 6)}-1111`, title: 'c', prompt: 'p', cwd: CWD, status: 'backlog', ...extra };
  store.state.tasks.unshift(t);
  return t;
}

test('a finished worktree run reaps its worktree before the slot frees, and logs what died', async () => {
  const t = card({ worktree: true });
  runner.startTask(t.id);
  await until(() => children.length === 1);
  children[0].emit('close', 0);
  await until(() => t.status === 'review');
  assert.deepEqual(reaped, [{ id: t.id, runningDuringReap: true }]);
  const lines = store.readTranscript(t.id).map((e) => e.text);
  assert.ok(lines.includes('end of run: killed process 5 (node.exe) running in the worktree'));
});

test('a non-worktree run is never reaped', async () => {
  const t = card({ worktree: false });
  runner.startTask(t.id);
  await until(() => children.length === 1);
  children[0].emit('close', 0);
  await until(() => t.status === 'review');
  assert.deepEqual(reaped, []);
});

test('reap problems land on the card as an error line', async () => {
  runner.reapRun = async () => ({ removed: [], notes: [], problems: ['could not kill process 9 running in the worktree'] });
  const t = card({ worktree: true });
  runner.startTask(t.id);
  await until(() => children.length === 1);
  children[0].emit('close', 1);
  await until(() => t.status === 'review');
  const errs = store.readTranscript(t.id).filter((e) => e.kind === 'error').map((e) => e.text);
  assert.ok(errs.some((x) => /could not kill process 9/.test(x)));
});

test('boot: cards a restart interrupted are reaped once and the flag clears', async () => {
  const t = card({ worktree: true, status: 'review', error: 'interrupted by server restart', reapPending: true });
  card({ worktree: true, status: 'review' }); // not interrupted: left alone
  await runner.reapInterrupted();
  assert.deepEqual(reaped.map((r) => r.id), [t.id]);
  assert.equal(t.reapPending, undefined);
});

test('stopAll marks a running worktree card for the boot reap', async () => {
  const t = card({ worktree: true });
  runner.startTask(t.id);
  await until(() => children.length === 1);
  runner.stopAll();
  assert.equal(t.reapPending, true);
  assert.equal(t.error, 'interrupted by server restart');
  children[0].emit('close', null); // let the fake child finish so the test exits clean
  await until(() => !runner.isRunning(t.id));
});
