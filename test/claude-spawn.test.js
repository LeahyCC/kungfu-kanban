// Regression for the 2026-10-20 crash: the prompt rode argv as `-p -- <prompt>`,
// Windows capped the command line at 32767 chars, spawn() threw ENAMETOOLONG
// synchronously, and the unhandled rejection killed the server with six cards
// running. The prompt now goes to the child's stdin, and a spawn that throws
// anyway becomes a launch failure on the card instead of a crash.
//
// child_process.spawn is stubbed BEFORE lib/runner is required (see
// runner-followup-resume.test.js for why).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');

const calls = [];
let behaviour = 'ok'; // 'ok' | 'throw'
cp.spawn = (cmd, args, opts) => {
  if (behaviour === 'throw') {
    const e = new Error('spawn ENAMETOOLONG');
    e.code = 'ENAMETOOLONG';
    throw e;
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new PassThrough();
  const call = { cmd, args, opts, stdin: '' };
  child.stdin.on('data', (d) => (call.stdin += d));
  calls.push(call);
  child.pid = 99999;
  child.kill = () => {};
  child.unref = () => {};
  return child;
};

process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-claude-spawn-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;
store.state.settings.maxConcurrent = 20; // earlier tests leave never-closing stub children holding slots
store.state.settings.maxRunMinutes = 0; // the stub child never closes; no watchdog timer to hold the process open

const { spawnClaude } = require('../lib/claude-spawn');
const runner = require('../lib/runner');
const errlog = require('../lib/errlog');

const BIG = 'x'.repeat(45_000);

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function soloTask(id, overrides) {
  store.state.tasks.length = 0;
  const task = { id, title: 'Card', status: 'queued', deps: [], prompt: 'do the thing', ...overrides };
  store.state.tasks.push(task);
  return task;
}

test('spawnClaude: a 45k-char prompt reaches stdin and never argv', async () => {
  behaviour = 'ok';
  calls.length = 0;
  spawnClaude(['--output-format', 'json', '-p'], BIG, { env: {} });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'claude');
  assert.equal(calls[0].stdin, BIG);
  assert.ok(!calls[0].args.some((a) => a.includes(BIG.slice(0, 100))), 'prompt leaked onto argv');
  assert.ok(calls[0].args.join(' ').length < 1000);
  assert.deepEqual(calls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
});

test('spawnClaude: a spawn that throws synchronously surfaces as an async error event, not a throw', async () => {
  behaviour = 'throw';
  let child;
  assert.doesNotThrow(() => { child = spawnClaude(['-p'], 'hi', {}); });
  const err = await new Promise((resolve) => child.on('error', resolve));
  assert.equal(err.code, 'ENAMETOOLONG');
  assert.equal(child.pid, undefined);
  behaviour = 'ok';
});

test('card run: a 45k-char card prompt is piped on stdin, not put on argv', async () => {
  behaviour = 'ok';
  calls.length = 0;
  soloTask('big-1', { prompt: BIG });
  assert.equal(runner.startTask('big-1').started, true);
  await until(() => calls.length === 1);
  await tick();
  assert.ok(calls[0].stdin.startsWith(BIG), 'child stdin must carry the whole prompt');
  assert.ok(!calls[0].args.some((a) => a.includes(BIG.slice(0, 100))));
  assert.equal(calls[0].args[calls[0].args.length - 1], '-p');
});

test('follow-up: a 45k-char message is piped on stdin, not put on argv', async () => {
  behaviour = 'ok';
  calls.length = 0;
  soloTask('big-2', { status: 'review', sessionId: 'sess-1', prompt: 'earlier work' });
  // followUp() caps the message at 10k, so seed pendingFollowUp directly to
  // exercise the resume path with a prompt past the Windows limit.
  const task = store.state.tasks[0];
  task.pendingFollowUp = BIG;
  assert.equal(runner.startTask('big-2').started, true);
  await until(() => calls.length === 1);
  await tick();
  assert.ok(calls[0].args.includes('-r'));
  assert.equal(calls[0].stdin, BIG);
  assert.ok(!calls[0].args.some((a) => a.includes(BIG.slice(0, 100))));
});

test('card run: a spawn that throws marks the card failed and logs it, and does not crash', async () => {
  behaviour = 'throw';
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on('unhandledRejection', onRej);
  try {
    soloTask('boom-1', { prompt: BIG });
    assert.equal(runner.startTask('boom-1').started, true);
    await until(() => store.state.tasks[0].status === 'review');
    const t = store.state.tasks[0];
    assert.match(t.error, /Failed to launch claude CLI: spawn ENAMETOOLONG/);
    assert.equal(runner.isRunning('boom-1'), false, 'the run slot is released');
    const logged = errlog.list().filter((e) => e.kind === 'launch-failed' && e.taskId === 'boom-1');
    assert.equal(logged.length, 1);
    await tick();
    assert.deepEqual(rejections, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onRej);
    behaviour = 'ok';
  }
});

test('Sensei: a spawn that throws is logged to errlog and the run releases busy', async () => {
  behaviour = 'throw';
  const manager = require('../lib/manager');
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on('unhandledRejection', onRej);
  try {
    await manager.invoke('task finished and awaits review: "x" (id x)').catch(() => {});
    await until(() => !manager.publicState().busy);
    const logged = errlog.list().filter((e) => e.kind === 'sensei' && /Manager launch failed: spawn ENAMETOOLONG/.test(e.text));
    assert.equal(logged.length, 1);
    await tick();
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRej);
    behaviour = 'ok';
  }
});
