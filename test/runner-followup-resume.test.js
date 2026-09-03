// Regression for the 2026-09-02 batch-running session: a card with a pending
// follow-up (added via the drawer while it was busy elsewhere) sat in Queued,
// and pressing ▶ Run on it went through startTask's fresh-run path, which
// built a brand-new prompt and silently dropped the follow-up instead of
// resuming the session it belongs to. startTask now checks pendingFollowUp
// the same way pumpQueue already does and resumes instead of restarting.
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

process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-followup-resume-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;

const { startTask } = require('../lib/runner');

// Distinct ids per test — a launched task lands in runner's module-private
// `running` Map (no 'close' event ever fires here to clear it), so reusing
// an id across tests would make the next startTask() see it as still running.
function soloTask(id, overrides) {
  store.state.tasks.length = 0;
  const task = {
    id, title: 'Card', status: 'queued', deps: [],
    prompt: 'original prompt', sessionId: 'sess-abc', pendingFollowUp: 'do one more thing',
    ...overrides,
  };
  store.state.tasks.push(task);
  return task;
}

test('startTask: a queued card with a pending follow-up resumes its session instead of starting fresh', () => {
  spawnCalls.length = 0;
  const task = soloTask('card-1');
  const res = startTask('card-1');
  assert.equal(res.started, true);
  assert.equal(spawnCalls.length, 1);
  const args = spawnCalls[0].args;
  assert.ok(args.includes('-r'), 'resumes via -r, not a fresh session');
  assert.equal(args[args.indexOf('-r') + 1], 'sess-abc');
  assert.equal(task.pendingFollowUp, null, 'consumed, not left dangling for the next launch');
  assert.match(task.prompt, /do one more thing/, 'the follow-up message reached the session');
});

test('startTask: a queued card with no pending follow-up still starts fresh as before', async () => {
  spawnCalls.length = 0;
  soloTask('card-2', { pendingFollowUp: null });
  const res = startTask('card-2');
  assert.equal(res.started, true);
  // The fresh-run path holds the slot across an async syncDefaultBranch()
  // before spawning, so the actual spawn lands a microtask after this call
  // returns — unlike the resume path above, which spawns synchronously.
  await new Promise((r) => setImmediate(r));
  assert.equal(spawnCalls.length, 1);
  assert.ok(!spawnCalls[0].args.includes('-r'), 'no resume flag on a fresh run');
});
