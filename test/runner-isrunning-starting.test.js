// Regression for the 2026-09-10 batch-running session: a card parked with a
// pending follow-up (POST /api/tasks/:id/followup, no free slot) sometimes
// got a second launch when a human pressed ▶ Run before the queue pump
// resumed it. startTask/startResume already guard against a double launch
// internally (the `starting` set holds the slot across the pre-launch
// awaits), but isRunning() — what the /run and delete routes check FIRST —
// only looked at `running`, which isn't populated until the child process
// actually spawns. In the gap between "launch committed" and "child spawned"
// a second request read isRunning() as false, fell through to
// runner.startTask()/stopTask(), and got a confusing response instead of a
// clean 409 — exactly the window where a fresh launch could stomp on a
// resume that was still spinning up. isRunning() now covers that gap too.
//
// child_process.spawn is stubbed BEFORE lib/runner is required, since
// runner.js destructures `spawn` into a module-local const at load time —
// patching child_process afterward would not reach it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const cp = require('child_process');

const spawnCalls = [];
cp.spawn = (cmd, args) => {
  spawnCalls.push({ cmd, args });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 99999;
  child.kill = () => {};
  child.unref = () => {};
  return child;
};

process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-isrunning-starting-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;
store.state.settings.maxRunMinutes = 0; // disable the watchdog timer (see runner-followup-resume.test.js)

const { startTask, isRunning } = require('../lib/runner');

function soloTask(id, overrides) {
  store.state.tasks.length = 0;
  const task = { id, title: 'Card', status: 'queued', deps: [], prompt: 'do the thing', ...overrides };
  store.state.tasks.push(task);
  return task;
}

test('isRunning: true the instant a launch is committed, before the child process actually spawns', () => {
  spawnCalls.length = 0;
  soloTask('card-1');
  const res = startTask('card-1');
  assert.equal(res.started, true);
  // startTask holds the slot in `starting` across an async pre-launch fetch
  // (syncDefaultBranch) before it ever calls spawn — the child hasn't been
  // created yet, so `running` is still empty here.
  assert.equal(spawnCalls.length, 0, 'spawn has not happened yet — this assertion is only meaningful mid-gap');
  assert.equal(isRunning('card-1'), true, 'a second launch attempt in this window must see the card as running');
});

test('isRunning: a concurrent startTask() call during that same gap is rejected, not double-launched', async () => {
  spawnCalls.length = 0;
  soloTask('card-2');
  const first = startTask('card-2');
  assert.equal(first.started, true);
  // Simulates a human mashing ▶ Run (or a second API caller) while the first
  // launch is still mid-gap — this is exactly the request server.js's
  // POST /api/tasks/:id/run would issue after isRunning() (now) says true.
  const second = startTask('card-2');
  assert.equal(second.error, 'not startable');
  await new Promise((r) => setImmediate(r));
  assert.equal(spawnCalls.length, 1, 'exactly one child process for the card, never two');
});

test('isRunning: false once the card is idle (queued, nothing launched)', () => {
  soloTask('card-3');
  assert.equal(isRunning('card-3'), false);
});
