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
