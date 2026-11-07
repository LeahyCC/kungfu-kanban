// The Sensei ships off (1.26.0): the session driving the board is the lead, and
// a manager running underneath it duplicates spend and merges unreviewed work.
// "Off" has to mean no automatic triggers, not deaf — a chat box that looks
// alive and silently swallows every message is worse than no chat box. So:
// event triggers do nothing, a message you typed still gets a run, and that run
// can only propose.
//
// child_process.spawn is stubbed BEFORE lib/manager is required.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');

const calls = [];
cp.spawn = (cmd, args, opts) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new PassThrough();
  const call = { cmd, args, opts, stdin: '' };
  child.stdin.on('data', (d) => (call.stdin += d));
  calls.push(call);
  child.pid = 99997;
  child.kill = () => {};
  child.unref = () => {};
  return child;
};

process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-mgr-off-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
store.state.settings.keepAwake = false;
const manager = require('../lib/manager');

const MGR_FILE = path.join(process.env.KFK_DATA_DIR, 'manager.json');
const persisted = () => JSON.parse(fs.readFileSync(MGR_FILE, 'utf8'));

// invoke() awaits buildPrompt before spawning, so the child appears a few ticks
// after chat() returns.
async function until(cond, ms = 2000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('the shipped default is off', () => {
  delete store.state.settings.manager;
  assert.equal(manager.config().enabled, false);
});

test('off: an automatic trigger spawns nothing', async () => {
  store.state.settings.manager = { enabled: false };
  calls.length = 0;
  await manager.invoke('task finished and awaits review: "x" (id x)');
  assert.deepEqual(calls, [], 'no claude run for a card finishing');
  await manager.invoke(manager.INTERVAL_TRIGGER);
  assert.deepEqual(calls, [], 'none for the interval either');
  assert.equal(manager.publicState().busy, false);
});

test('off: a message you typed still gets a run', async () => {
  store.state.settings.manager = { enabled: false };
  calls.length = 0;
  manager.chat('what is blocking?');
  assert.equal(manager.publicState().busy, true, 'the chat run started');
  assert.ok(await until(() => calls.length === 1), 'claude was spawned for the human message');
  assert.equal(manager.publicState().chat.at(-1).text, 'what is blocking?', 'the message is in the thread');
  manager.stopCurrent();
});

// The whole point of the clamp: asking a switched-off Sensei a question is not
// the same as switching it back on. Even left on autonomy 'auto' it proposes.
test('off: its actions are held as suggestions even on autonomy auto', () => {
  store.state.settings.manager = { enabled: false, autonomy: 'auto' };
  manager.clearChat();
  const before = persisted().suggestions.length;
  manager.finishInvocation(
    JSON.stringify({ result: JSON.stringify({ reply: 'here you go', actions: [{ type: 'create_task', title: 'Off-Sensei card', prompt: 'x' }] }) }),
    '',
    'chat message from human',
    true,
  );
  assert.equal(persisted().suggestions.length, before + 1, 'proposed, not executed');
  assert.equal(store.state.tasks.filter((t) => t.title === 'Off-Sensei card').length, 0, 'no card created');
});

test('on + auto still acts, so the clamp is the enabled flag and nothing else', () => {
  store.state.settings.manager = { enabled: true, autonomy: 'auto' };
  const before = persisted().suggestions.length;
  manager.finishInvocation(
    JSON.stringify({ result: JSON.stringify({ actions: [{ type: 'create_task', title: 'On-Sensei card', prompt: 'x' }] }) }),
    '',
    'chat message from human',
    true,
  );
  assert.equal(persisted().suggestions.length, before, 'nothing held');
  assert.equal(store.state.tasks.filter((t) => t.title === 'On-Sensei card').length, 1, 'card created');
});
