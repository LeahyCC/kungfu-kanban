// sweepArchive(): the daily age-based sweep and the Done column's "clear"
// broom share one implementation, so this pins both halves — in particular
// that { all: true } ignores BOTH the age cutoff and the archiveDays=0 switch
// that turns the daily sweep off, while still refusing to touch a card that
// isn't done.
// KFK_DATA_DIR must be set before requiring lib/store so nothing here ever
// touches the checkout's data/.
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kfk-archive-done-'));

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const DATA_DIR = process.env.KFK_DATA_DIR;
const store = require('../lib/store');

after(() => {
  store.flush();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// two done cards (one ancient, one finished a minute ago) plus one of every
// status that must survive any sweep
function seed() {
  store.state.tasks = [];
  store.state.tasks.push(
    { id: 'old', title: 'old done', status: 'done', finishedAt: ago(40 * DAY) },
    { id: 'fresh', title: 'fresh done', status: 'done', finishedAt: ago(60 * 1000) },
    { id: 'backlog', title: 'waiting', status: 'backlog', createdAt: ago(40 * DAY) },
    { id: 'review', title: 'in review', status: 'review', finishedAt: ago(40 * DAY) },
    { id: 'running', title: 'running', status: 'running', createdAt: ago(40 * DAY) },
  );
}

beforeEach(() => {
  fs.rmSync(require('path').join(DATA_DIR, 'archive.jsonl'), { force: true });
  store.state.settings.archiveDays = 30;
  seed();
});

const ids = (list) => list.map((t) => t.id).sort();
const boardIds = () => store.state.tasks.map((t) => t.id).sort();

test('daily sweep takes only done cards past the age cutoff', () => {
  const archived = store.sweepArchive();
  assert.deepEqual(ids(archived), ['old']);
  assert.deepEqual(boardIds(), ['backlog', 'fresh', 'review', 'running']);
});

test('{ all: true } takes every done card regardless of age', () => {
  const archived = store.sweepArchive({ all: true });
  assert.deepEqual(ids(archived), ['fresh', 'old']);
  // everything that was never done stays put — clearing Done is not "clear all"
  assert.deepEqual(boardIds(), ['backlog', 'review', 'running']);
});

// archiveDays=0 means "never auto-archive". The manual broom must still work,
// or the Clear button would silently do nothing on those boards.
test('{ all: true } still sweeps when auto-archiving is switched off', () => {
  store.state.settings.archiveDays = 0;
  assert.deepEqual(store.sweepArchive(), [], 'daily sweep stays off');
  assert.deepEqual(ids(store.sweepArchive({ all: true })), ['fresh', 'old']);
  assert.deepEqual(boardIds(), ['backlog', 'review', 'running']);
});

test('swept cards are appended to the archive and readable back', () => {
  store.sweepArchive({ all: true });
  assert.deepEqual(ids(store.readArchive()), ['fresh', 'old']);
  assert.equal(store.readArchive().find((t) => t.id === 'old').title, 'old done');
});

test('sweeping an empty Done column archives nothing and leaves the board alone', () => {
  store.sweepArchive({ all: true });
  const before = boardIds();
  assert.deepEqual(store.sweepArchive({ all: true }), []);
  assert.deepEqual(boardIds(), before);
});
