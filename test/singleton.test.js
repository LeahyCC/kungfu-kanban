// Regression for the six-day orphan: a second `node server.js` on the same
// data dir ran a full automation loop against the live board (see lib/singleton.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-singleton-test-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { claim, release, readHolder, LOCK } = require('../lib/singleton');

const noSleep = () => {};
const reset = () => { try { fs.unlinkSync(LOCK); } catch {} };

test('claim: takes a free lock and records our pid', () => {
  reset();
  assert.equal(claim(() => false, noSleep), null);
  assert.equal(readHolder(), process.pid);
  release();
  assert.equal(readHolder(), null);
});

test('claim: refuses when a live server already holds the data dir', () => {
  reset();
  fs.writeFileSync(LOCK, '4242');
  assert.equal(claim(() => true, noSleep), 4242, 'returns the holder so the caller can name it');
  assert.equal(readHolder(), 4242, 'and does not steal the lock');
  reset();
});

test('claim: takes over a stale lock whose process is gone', () => {
  reset();
  fs.writeFileSync(LOCK, '4242');
  assert.equal(claim(() => false, noSleep), null, 'a dead holder must not strand the board');
  assert.equal(readHolder(), process.pid);
  reset();
});

test('claim: waits out a holder that is still shutting down (kickstart -k)', () => {
  reset();
  fs.writeFileSync(LOCK, '4242');
  let calls = 0;
  // Alive for the first few polls, then gone — the launchd restart race.
  const isLive = () => ++calls < 3;
  assert.equal(claim(isLive, noSleep), null);
  assert.equal(readHolder(), process.pid);
  assert.ok(calls >= 3, 'it actually retried rather than giving up on the first look');
  reset();
});

test('claim: a garbage or empty lock file is not a holder', () => {
  for (const junk of ['', 'not-a-pid', '0', '-1']) {
    reset();
    fs.writeFileSync(LOCK, junk);
    assert.equal(readHolder(), null, `"${junk}" is not a pid`);
    assert.equal(claim(() => true, noSleep), null, `"${junk}" must not block startup`);
  }
  reset();
});

test('release: leaves another server lock alone', () => {
  reset();
  fs.writeFileSync(LOCK, '4242');
  release();
  assert.equal(readHolder(), 4242, 'only the holder may release');
  reset();
});

test('holderIsLive: checks liveness without ps (Windows has none)', () => {
  const { holderIsLive } = require('../lib/singleton');
  assert.equal(typeof holderIsLive(process.pid), 'boolean');
  assert.equal(holderIsLive(2147483000), false, 'a pid that does not exist is not live');
});

test('claim: a lock created by another server in the meantime is respected', () => {
  reset();
  fs.writeFileSync(LOCK, '4242');
  assert.equal(claim(() => true, noSleep), 4242);
  assert.equal(readHolder(), 4242);
  reset();
});

// In-memory fs with a hook that fires on every read of the lock, so a test can
// run a second server's whole claim() at the exact moment the first one is
// between "looked" and "acted".
function fakeFs(initial, onRead) {
  const files = new Map(Object.entries(initial));
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    files,
    readFileSync(p) {
      if (onRead) onRead(p);
      if (!files.has(p)) throw err('ENOENT');
      return files.get(p);
    },
    writeFileSync(p, data, opts) {
      if (opts && opts.flag === 'wx' && files.has(p)) throw err('EEXIST');
      files.set(p, String(data));
    },
    renameSync(from, to) {
      if (!files.has(from)) throw err('ENOENT');
      files.set(to, files.get(from));
      files.delete(from);
    },
    linkSync(from, to) {
      if (files.has(to)) throw err('EEXIST');
      files.set(to, files.get(from));
    },
    unlinkSync(p) {
      if (!files.has(p)) throw err('ENOENT');
      files.delete(p);
    },
  };
}

// Run `other` once, the first time the lock is read.
function raceOnFirstRead(initial, other) {
  let fired = false;
  let result = null;
  const fx = fakeFs(initial, (p) => {
    if (fired || p !== LOCK) return;
    fired = true;
    result = other(fx);
  });
  return { fx, result: () => result };
}

const A = 1111;
const B = 2222;
const alive = (pid) => pid === A || pid === B; // 4242 is the dead holder

test('claim: two servers starting on an empty data dir cannot both win', () => {
  // A has read "no lock". Before it acts, B runs its whole claim and wins.
  const { fx, result } = raceOnFirstRead({}, (f) => claim(alive, noSleep, f, B));
  const a = claim(alive, noSleep, fx, A);
  assert.equal(result(), null, 'B finished first, so it holds the lock');
  assert.equal(a, B, 'A must lose and name B, not delete B\'s lock and also win');
  assert.equal(fx.files.get(LOCK), String(B), 'B\'s lock is intact');
});

test('claim: two servers racing for one stale lock cannot both win', () => {
  // A has read the stale 4242. B clears it and takes the lock before A's rename.
  const { fx, result } = raceOnFirstRead({ [LOCK]: '4242' }, (f) => claim(alive, noSleep, f, B));
  const a = claim(alive, noSleep, fx, A);
  assert.equal(result(), null);
  assert.equal(a, B, 'A moved B\'s fresh lock aside by mistake, so it must put it back and defer');
  assert.equal(fx.files.get(LOCK), String(B));
  assert.deepEqual([...fx.files.keys()], [LOCK], 'no stale.* leftovers');
});

test('claim: clearing a stale lock leaves no stale.* files behind', () => {
  const fx = fakeFs({ [LOCK]: '4242' });
  assert.equal(claim(() => false, noSleep, fx, A), null);
  assert.deepEqual([...fx.files.keys()], [LOCK]);
  assert.equal(fx.files.get(LOCK), String(A));
});

test('claim: an unwritable dir does not block startup', () => {
  const denied = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  const stale = fakeFs({ [LOCK]: '4242' });
  stale.renameSync = denied;
  assert.equal(claim(() => false, noSleep, stale, A), null);
  const empty = fakeFs({});
  empty.writeFileSync = denied;
  assert.equal(claim(() => false, noSleep, empty, A), null);
});
