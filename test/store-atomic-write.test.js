// Regression for the 2026-10-03 crash: writeJsonAtomic renamed a shared
// `<file>.tmp` that something else had already taken (ENOENT), and because it
// ran from the debounce timer the throw killed the whole board.
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kfk-store-atomic-'));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.KFK_DATA_DIR;
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

const store = require('../lib/store');
const errlog = require('../lib/errlog');

const realRename = fs.renameSync;
after(() => {
  fs.renameSync = realRename;
  store.flush();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errno = (code) => Object.assign(new Error(`${code}: simulated`), { code });
const leftovers = () => fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp'));

test('a tmp file taken by someone else does not break the write', () => {
  const file = path.join(DATA_DIR, 'a.json');
  // The old fixed name; a unique per-write name never collides with it.
  fs.writeFileSync(file + '.tmp', 'someone else');
  fs.renameSync = (from, to) => {
    if (from === file + '.tmp') throw errno('ENOENT');
    return realRename(from, to);
  };
  try {
    store.writeJsonAtomic(file, { ok: 1 }, { backup: false });
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: 1 });
  assert.equal(fs.readFileSync(file + '.tmp', 'utf8'), 'someone else', 'does not touch a foreign tmp');
  fs.unlinkSync(file + '.tmp');
});

test('rename is retried on EBUSY then succeeds', () => {
  const file = path.join(DATA_DIR, 'b.json');
  let calls = 0;
  fs.renameSync = (from, to) => {
    if (++calls <= 2) throw errno('EBUSY');
    return realRename(from, to);
  };
  try {
    store.writeJsonAtomic(file, { n: 2 }, { backup: false });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 });
  assert.deepEqual(leftovers(), []);
});

test('final failure throws and cleans up its tmp file', () => {
  const file = path.join(DATA_DIR, 'c.json');
  fs.renameSync = () => {
    throw errno('EPERM');
  };
  try {
    assert.throws(() => store.writeJsonAtomic(file, { n: 3 }, { backup: false }), { code: 'EPERM' });
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(leftovers(), [], 'no orphan .tmp left behind');
  assert.equal(fs.existsSync(file), false);
});

test('a failed debounced save is reported, not thrown, and retried', async () => {
  store.state.tasks = [];
  store.state.tasks.push({ id: 'w1', title: 'x', status: 'backlog' });
  fs.renameSync = () => {
    throw errno('ENOENT'); // not retryable: fails at once
  };
  store.save();
  await sleep(700); // timer fires; on the old code this is an uncaught exception
  assert.ok(
    errlog.list().some((e) => e.kind === 'store' && /tasks\.json/.test(e.text)),
    'failure reported through errlog',
  );
  assert.equal(fs.existsSync(TASKS_FILE), false, 'nothing written while rename is broken');

  fs.renameSync = realRename;
  await sleep(700); // dirty flag was re-armed, so the next window retries by itself
  assert.equal(JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'))[0].id, 'w1');
});
