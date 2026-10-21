/* Boot sweep of orphan transcripts must survive a file it cannot delete.
 * Regression for #67: on Windows a locked transcript makes unlinkSync throw
 * EPERM/EBUSY, and with no try/catch that aborted lib/store.js at require
 * time, so the server never started. We simulate the lock by making unlink
 * fail for one file and check the require still completes and the other
 * orphan is still swept. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-sweep-locked-'));
process.env.KFK_DATA_DIR = dataDir;

const transcripts = path.join(dataDir, 'transcripts');
fs.mkdirSync(transcripts, { recursive: true });
const locked = path.join(transcripts, 'locked-card.jsonl');
const free = path.join(transcripts, 'free-card.jsonl');
fs.writeFileSync(locked, '');
fs.writeFileSync(free, '');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('a locked orphan transcript does not stop the store from loading', () => {
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (p) => {
    if (path.resolve(p) === path.resolve(locked)) {
      const err = new Error('EPERM: operation not permitted, unlink');
      err.code = 'EPERM';
      throw err;
    }
    return realUnlink(p);
  };
  try {
    assert.doesNotThrow(() => require('../lib/store.js'));
  } finally {
    fs.unlinkSync = realUnlink;
  }

  assert.equal(fs.existsSync(free), false, 'unlocked orphan still swept');
  assert.equal(fs.existsSync(locked), true, 'locked file left in place');
});
