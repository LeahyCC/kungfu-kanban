// A launching card resolves its `uses:` contracts, records them as
// contractsUsed, and receives their text in the prompt. child_process.spawn is
// stubbed BEFORE lib/runner is required (see runner-followup-resume.test.js).
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');

const calls = [];
cp.spawn = (cmd, args, opts) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new PassThrough();
  const call = { cmd, args, opts, child, stdin: '' };
  child.stdin.on('data', (d) => (call.stdin += d));
  calls.push(call);
  child.pid = 99999;
  child.kill = () => {};
  child.unref = () => {};
  return child;
};

require('./helpers/temp-data-dir');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const store = require('../lib/store');
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;
store.state.settings.maxConcurrent = 50; // stub children never close and hold their slots
store.state.settings.maxRunMinutes = 0;

const contracts = require('../lib/contracts');
const runner = require('../lib/runner');
const errlog = require('../lib/errlog');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function solo(id, overrides) {
  store.state.tasks.length = 0;
  const task = { id, title: 'Card', status: 'queued', deps: [], prompt: 'build the client', ...overrides };
  store.state.tasks.push(task);
  return task;
}

// Starts the card and waits for its spawn; returns that spawn's recorded call.
async function launch(id) {
  const before = calls.length;
  assert.equal(runner.startTask(id).started, true);
  await until(() => calls.length === before + 1);
  await new Promise((r) => setImmediate(r));
  return calls[before];
}

test('unpinned resolves to the latest version at launch', async () => {
  contracts.publish({ name: 'api', content: 'v1 text' });
  contracts.publish({ name: 'api', content: 'v2 text' });
  const task = solo('latest-1', { uses: [{ name: 'api', version: null }] });
  const call = await launch('latest-1');
  assert.deepEqual(task.contractsUsed, [{ name: 'api', version: 2, sha256: sha('v2 text') }]);
  assert.match(call.stdin, /v2 text/);
  assert.doesNotMatch(call.stdin, /v1 text/);
});

test('pinned resolves to that version even when newer ones exist', async () => {
  contracts.publish({ name: 'pin', content: 'pin one' });
  contracts.publish({ name: 'pin', content: 'pin two' });
  contracts.publish({ name: 'pin', content: 'pin three' });
  const task = solo('pinned-1', { uses: [{ name: 'pin', version: 1 }] });
  const call = await launch('pinned-1');
  assert.deepEqual(task.contractsUsed, [{ name: 'pin', version: 1, sha256: sha('pin one') }]);
  assert.match(call.stdin, /pin one/);
  assert.doesNotMatch(call.stdin, /pin (two|three)/);
});

test('the prompt carries the header, the sha and the fenced text', async () => {
  contracts.publish({ name: 'shape', content: 'line 1\n```js\ninner\n```\nline 2' });
  solo('prompt-1', { uses: [{ name: 'shape', version: null }] });
  const call = await launch('prompt-1');
  const want = sha('line 1\n```js\ninner\n```\nline 2');
  assert.ok(call.stdin.startsWith('build the client'), 'the card prompt still comes first');
  assert.ok(call.stdin.includes(`Contract \`shape\` v1 (sha256 ${want}), built against this exact version:`));
  // The contract holds a ``` fence, so the wrapper must be longer than that.
  assert.ok(call.stdin.includes('\n````\nline 1\n```js\ninner\n```\nline 2\n````'));
});

test('a re-run records again: the new latest, and the sha of what it got', async () => {
  contracts.publish({ name: 'rerun', content: 'first' });
  const task = solo('rerun-1', { uses: [{ name: 'rerun', version: null }] });
  await launch('rerun-1');
  assert.equal(task.contractsUsed[0].version, 1);

  contracts.publish({ name: 'rerun', content: 'second' });
  // The stub child never closes; a launch error frees the run slot and parks the card in review.
  calls[calls.length - 1].child.emit('error', new Error('stub exit'));
  assert.equal(runner.isRunning('rerun-1'), false);
  const call = await launch('rerun-1');
  assert.deepEqual(task.contractsUsed, [{ name: 'rerun', version: 2, sha256: sha('second') }]);
  assert.match(call.stdin, /second/);
});

test('a resume records again and sends the contract with the follow-up', async () => {
  contracts.publish({ name: 'resume', content: 'old' });
  const task = solo('resume-1', { uses: [{ name: 'resume', version: null }], sessionId: 'sess-1', status: 'review' });
  contracts.publish({ name: 'resume', content: 'newer' });
  task.pendingFollowUp = 'one more thing';
  const call = await launch('resume-1');
  assert.ok(call.args.includes('-r'));
  assert.deepEqual(task.contractsUsed, [{ name: 'resume', version: 2, sha256: sha('newer') }]);
  assert.ok(call.stdin.startsWith('one more thing'));
  assert.match(call.stdin, /Contract `resume` v2/);
});

test('a card with no uses gets no contract block and an empty record', async () => {
  const task = solo('none-1');
  const call = await launch('none-1');
  assert.deepEqual(task.contractsUsed, []);
  assert.doesNotMatch(call.stdin, /built against this exact version/);
});

test('a contract that cannot be read fails the launch with a card error', () => {
  const before = calls.length;
  // Readiness is skipped by going through startTask on a name the store lost.
  const task = solo('gone-1', { uses: [{ name: 'never-published', version: null }] });
  const orig = require('../lib/deps').unmetUses;
  require('../lib/deps').unmetUses = () => [];
  try {
    const res = runner.startTask('gone-1');
    assert.match(res.error, /could not be read at launch/);
  } finally {
    require('../lib/deps').unmetUses = orig;
  }
  assert.equal(calls.length, before, 'nothing was spawned');
  assert.equal(task.status, 'review');
  assert.match(task.error, /Failed to launch: contract never-published could not be read at launch/);
  assert.ok(errlog.list().some((e) => e.kind === 'launch-failed' && e.taskId === 'gone-1'));
});
