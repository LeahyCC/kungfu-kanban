// Regression: the scheduled interval trigger must not spawn Sensei runs on an
// idle board (the "nothing to do — standing by" spam). Isolated data dir so
// the checkout's data/ is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-mgr-idle-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
const errlog = require('../lib/errlog');
const manager = require('../lib/manager');
const { state } = store;

const MGR_LOG = path.join(process.env.KFK_DATA_DIR, 'manager-log.jsonl');

function cleanup() {
  state.tasks.length = 0;
  for (const e of errlog.list()) if (!e.resolved) errlog.resolve(e.id, 'test');
  try { fs.writeFileSync(MGR_LOG, ''); } catch {}
  manager.clearLog(); // resets the manager's parsed-log cache too
}

function logLines() {
  try {
    return fs.readFileSync(MGR_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test('boardIdle: empty board is idle; queue/review/running/errors/suggestions are not', () => {
  cleanup();
  assert.equal(manager.boardIdle(), true, 'empty board');

  for (const status of ['backlog', 'done']) {
    state.tasks.push({ id: `t-${status}`, status });
    assert.equal(manager.boardIdle(), true, `${status}-only board is still idle`);
    state.tasks.length = 0;
  }
  for (const status of ['queued', 'running', 'stopping', 'review']) {
    state.tasks.push({ id: `t-${status}`, status });
    assert.equal(manager.boardIdle(), false, `${status} keeps the Sensei alive`);
    state.tasks.length = 0;
  }

  errlog.capture('run-failed', { text: 'boom' });
  assert.equal(manager.boardIdle(), false, 'open error keeps the Sensei alive');
  cleanup();
});

test('interval invoke on an idle board: no run, no chat spam, one quiet log line', async () => {
  cleanup();
  const chatBefore = manager.publicState().chat.length;

  await manager.invoke(manager.INTERVAL_TRIGGER);
  assert.equal(manager.publicState().busy, false, 'no run started');
  assert.equal(manager.publicState().chat.length, chatBefore, 'no chat message appended');
  const skips1 = logLines().filter((e) => e.kind === 'info' && /interval check skipped/.test(e.text));
  assert.equal(skips1.length, 1, 'first skip explains itself once');

  await manager.invoke(manager.INTERVAL_TRIGGER);
  const skips2 = logLines().filter((e) => e.kind === 'info' && /interval check skipped/.test(e.text));
  assert.equal(skips2.length, 1, 'subsequent idle skips stay silent');
  cleanup();
});

test('interval invoke with a queued card passes the gate (would run)', async () => {
  cleanup();
  state.tasks.push({ id: 't-work', status: 'queued' });
  // Don't actually invoke (that would spawn the real claude CLI) — the gate
  // itself is the contract: not idle ⇒ invoke proceeds past it.
  assert.equal(manager.boardIdle(), false);
  cleanup();
});

test('non-interval triggers are never gated', async () => {
  cleanup();
  // Prove an event-driven trigger on an idle board proceeds past the gate
  // WITHOUT spawning a real CLI: hide `claude` from PATH so the spawn fails
  // harmlessly (subEnv passes process.env through).
  const realPath = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-empty-path-'));
  try {
    const p = manager.invoke('task finished and awaits review: "x" (id x)');
    assert.equal(manager.publicState().busy, true, 'event trigger proceeds to a run');
    await p.catch(() => {});
    // spawn ENOENT lands async — wait for the launch-failed path to settle
    for (let i = 0; i < 40 && manager.publicState().busy; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(manager.publicState().busy, false);
    const fails = logLines().filter((e) => e.kind === 'error' && /Manager launch failed/.test(e.text));
    assert.equal(fails.length, 1, 'the un-gated run reached the spawn stage');
  } finally {
    process.env.PATH = realPath;
  }
  cleanup();
});
