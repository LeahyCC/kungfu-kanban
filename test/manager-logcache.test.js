// manager.js log cache: publicState() must parse manager-log.jsonl once across
// repeated calls, log() appends must reach readers without a re-parse, and
// clearLog must reset the cache. KFK_DATA_DIR is set before any lib require so
// the checkout's data/ is never touched.
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kfk-mgr-logcache-'));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MGR_LOG = path.join(process.env.KFK_DATA_DIR, 'manager-log.jsonl');

const store = require('../lib/store');
const manager = require('../lib/manager');

// Count reads of the manager log only, patched after require.
const realRead = fs.readFileSync;
let mgrLogReads = 0;
fs.readFileSync = function (p, ...rest) {
  if (String(p) === MGR_LOG) mgrLogReads++;
  return realRead.call(this, p, ...rest);
};

after(() => {
  fs.readFileSync = realRead;
  store.flush(); // drains any debounced writes from config()'s saveSettings()
  fs.rmSync(process.env.KFK_DATA_DIR, { recursive: true, force: true });
});

// A baseline read that bypasses the counting patch and the cache.
function uncachedTail(n = 40) {
  return realRead
    .call(fs, MGR_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-n)
    .map((l) => JSON.parse(l))
    .reverse();
}

const seeded = [
  { ts: '2026-07-22T00:00:00Z', kind: 'note', text: 'first' },
  { ts: '2026-07-22T00:01:00Z', kind: 'action', text: 'second' },
  { ts: '2026-07-22T00:02:00Z', kind: 'error', text: 'third' },
];

test('readLog parses the file once across repeated publicState calls', () => {
  fs.writeFileSync(MGR_LOG, seeded.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const a = manager.publicState().log;
  assert.equal(mgrLogReads, 1, 'first call parses the file');
  const b = manager.publicState().log;
  const c = manager.publicState().log;
  assert.equal(mgrLogReads, 1, 'later calls are served from the cache');

  const baseline = uncachedTail();
  assert.deepEqual(a, baseline, 'content identical to an uncached baseline');
  assert.deepEqual(b, baseline);
  assert.deepEqual(c, baseline);
});

test('log() appends reach readers without a file re-parse', () => {
  const before = mgrLogReads;
  manager.log('note', 'fourth');
  const out = manager.publicState().log;
  assert.equal(mgrLogReads, before, 'append path keeps the cache coherent');
  assert.equal(out[0].text, 'fourth', 'newest entry first (publicState reverses)');
  assert.equal(out.length, 4);
  assert.deepEqual(out, uncachedTail(), 'still identical to what an uncached read would return');
});

test('clearLog empties the cache; later appends still reach readers', () => {
  manager.clearLog();
  assert.deepEqual(manager.publicState().log, []);
  const before = mgrLogReads;
  manager.log('note', 'fifth');
  const out = manager.publicState().log;
  assert.equal(mgrLogReads, before, 'no re-parse after the reset either');
  assert.deepEqual(out.map((e) => e.text), ['fifth']);
  assert.deepEqual(out, uncachedTail());
});
