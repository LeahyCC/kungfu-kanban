// store.js performance behavior: tasks/settings write split, compact JSON,
// .bak policy, debounce + max-wait, revision counter, and the O(1) task index.
// KFK_DATA_DIR must be set before requiring lib/store so nothing here ever
// touches the checkout's data/.
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kfk-store-perf-'));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.KFK_DATA_DIR;
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const store = require('../lib/store');

after(() => {
  store.flush(); // drains timers + dirty flags so nothing writes after the rm
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- write reduction ---------------------------------------------------------

test('save() writes tasks.json but leaves settings.json untouched', async () => {
  store.state.tasks = [];
  store.state.tasks.push({ id: 't1', title: 'x', status: 'backlog' });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ marker: 'keep-me' }, null, 2));
  const before = fs.readFileSync(SETTINGS_FILE, 'utf8');
  const beforeMtime = fs.statSync(SETTINGS_FILE).mtimeMs;

  store.save();
  await sleep(700); // past the 400ms debounce

  assert.ok(fs.existsSync(TASKS_FILE), 'tasks.json written');
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), before, 'settings.json content unchanged');
  assert.equal(fs.statSync(SETTINGS_FILE).mtimeMs, beforeMtime, 'settings.json not rewritten');
});

test('saveSettings() persists settings.json (pretty-printed)', async () => {
  store.state.settings.someNewKey = 'hello';
  store.saveSettings();
  await sleep(700);
  const content = fs.readFileSync(SETTINGS_FILE, 'utf8');
  assert.equal(content, JSON.stringify(store.state.settings, null, 2));
  assert.ok(content.includes('\n'), 'settings stays human-readable');
  delete store.state.settings.someNewKey;
});

test('tasks.json is written compact (no pretty whitespace)', async () => {
  store.state.tasks = [];
  store.state.tasks.push({ id: 'compact-1', status: 'backlog' });
  store.save();
  await sleep(700);
  const content = fs.readFileSync(TASKS_FILE, 'utf8');
  assert.equal(content, JSON.stringify(store.state.tasks));
  assert.ok(!content.includes('\n'), 'machine state is one line');
});

test('.bak is written on flush() but not on debounced save', async () => {
  store.state.tasks = [];
  store.state.tasks.push({ id: 'bak-1', status: 'backlog' });
  const BAK = TASKS_FILE + '.bak';
  fs.rmSync(BAK, { force: true });

  store.save();
  await sleep(700);
  assert.ok(fs.existsSync(TASKS_FILE));
  assert.ok(!fs.existsSync(BAK), 'first debounced save writes no .bak');

  // A debounced save over an existing live file (the path that used to copy
  // .bak every time) still writes none.
  store.state.tasks.push({ id: 'bak-2', status: 'backlog' });
  store.save();
  await sleep(700);
  assert.ok(!fs.existsSync(BAK), 'debounced save over a live file writes no .bak');

  store.flush();
  assert.ok(fs.existsSync(BAK), 'shutdown flush writes .bak');
});

test('max-wait cap forces a flush during continuous save() calls', async () => {
  store.state.tasks = [];
  fs.rmSync(TASKS_FILE, { force: true });
  const start = Date.now();
  let flushedAt = null;
  // Save faster than the 400ms debounce: a resetting debounce alone would
  // starve; the ~2s max-wait must force a flush anyway.
  while (Date.now() - start < 2600) {
    store.state.tasks[0] = { id: 'mw', status: 'backlog', tick: Date.now() };
    store.save();
    await sleep(100);
    if (!flushedAt && fs.existsSync(TASKS_FILE)) flushedAt = Date.now();
  }
  assert.ok(flushedAt, 'tasks.json flushed at all under continuous saves');
  assert.ok(flushedAt - start < 2400, `flushed after ${flushedAt - start}ms — expected the ~2s max-wait cap`);
});

// --- revision counter ----------------------------------------------------------

test('nextRev/touch are monotonic and drive state.seq', () => {
  const a = store.nextRev();
  const b = store.nextRev();
  assert.ok(b > a);
  const task = { id: 'rev-1' };
  store.touch(task);
  assert.equal(task.v, b + 1);
  const v1 = task.v;
  store.touch(task);
  assert.ok(task.v > v1);
  assert.equal(store.state.seq, task.v);
});

// --- O(1) task index -----------------------------------------------------------

test('task index stays correct through push/unshift/splice/filter and lazy-repairs', () => {
  store.state.tasks = [];
  const a = { id: 'ix-a' };
  const b = { id: 'ix-b' };
  const c = { id: 'ix-c' };

  store.state.tasks.push(a, b);
  assert.equal(store.getTask('ix-a'), a);
  assert.equal(store.getTask('ix-b'), b);

  store.state.tasks.unshift(c); // manager/prwatch create pattern
  assert.equal(store.getTask('ix-c'), c);
  assert.equal(store.getTask('ix-a'), a);

  store.state.tasks.splice(1, 1); // removes a (c is at 0)
  assert.equal(store.getTask('ix-a'), undefined);
  assert.equal(store.getTask('ix-b'), b);

  // Reassignment via filter — the server.js delete pattern, not visible to
  // the wrapped mutators; the reference check must trigger a rebuild.
  store.state.tasks = store.state.tasks.filter((t) => t.id !== 'ix-b');
  assert.equal(store.getTask('ix-b'), undefined);
  assert.equal(store.getTask('ix-c'), c);

  // length= truncation — the test-suite withTasks pattern.
  store.state.tasks.length = 0;
  assert.equal(store.getTask('ix-c'), undefined);
  const d = { id: 'ix-d' };
  store.state.tasks.push(d);
  assert.equal(store.getTask('ix-d'), d);

  // Explicit rebuild on a fresh array.
  store.state.tasks = [{ id: 'ix-e' }];
  store.reindex();
  assert.equal(store.getTask('ix-e').id, 'ix-e');
});

// --- transcript batching ---------------------------------------------------------

test('transcript appends batch to disk and readTranscript merges the buffer', async () => {
  const id = 'tr-1';
  const file = path.join(DATA_DIR, 'transcripts', 'tr-1.jsonl');
  store.clearTranscript(id);

  store.appendTranscript(id, { kind: 'assistant', text: 'one' });
  assert.ok(!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes('one'), 'buffered, not yet on disk');
  assert.deepEqual(store.readTranscript(id).map((e) => e.text), ['one'], 'readers see the buffer');

  store.flushTranscripts(id);
  assert.deepEqual(store.readTranscript(id).map((e) => e.text), ['one']);

  store.appendTranscript(id, { kind: 'assistant', text: 'two' });
  await sleep(700); // rides the save debounce
  assert.deepEqual(store.readTranscript(id).map((e) => e.text), ['one', 'two'], 'ordering preserved');

  store.clearTranscript(id);
  assert.deepEqual(store.readTranscript(id), [], 'clear drops file and buffer');
});
