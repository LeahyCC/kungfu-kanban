// Wiring: a merged PR triggers cleanup behind the cleanupOnMerge setting, and a
// cleanup failure is logged on the card without breaking the sweep.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-wtsweep-'));

const prflow = require('../lib/prflow');
prflow.run = async () => ({ ok: true, out: JSON.stringify({ state: 'MERGED', baseRefName: 'develop', statusCheckRollup: [] }), err: '' });

const store = require('../lib/store');
const runner = require('../lib/runner');
const wtcleanup = require('../lib/wtcleanup');
const prwatch = require('../lib/prwatch');
runner.pumpQueue = () => {};

let cleaned;
let result;
wtcleanup.cleanupMergedCard = async (t, base) => { cleaned.push([t.id, base]); return result; };

function card() {
  store.state.tasks.length = 0;
  const t = { id: 'bbbbbbbb-2222', title: 'Merged card', status: 'review', cwd: '/x', prUrl: 'https://github.com/x/y/pull/2' };
  store.state.tasks.push(t);
  return t;
}

beforeEach(() => {
  cleaned = [];
  result = { removed: ['worktree /x/wt'], problems: [], notes: [] };
  delete store.state.settings.cleanupOnMerge;
});

test('merged PR runs cleanup against the PR base by default', async () => {
  const t = card();
  await prwatch.sweep();
  assert.equal(t.status, 'done');
  assert.deepEqual(cleaned, [[t.id, 'develop']]);
});

test('cleanupOnMerge=false skips cleanup', async () => {
  const t = card();
  store.state.settings.cleanupOnMerge = false;
  await prwatch.sweep();
  assert.equal(t.status, 'done');
  assert.deepEqual(cleaned, []);
});

test('cleanup problems and a thrown cleanup never break the sweep', async () => {
  let t = card();
  result = { removed: [], problems: ['git worktree remove failed: locked'], notes: [] };
  await prwatch.sweep();
  assert.equal(t.status, 'done');
  const open = require('../lib/errlog').list().filter((e) => !e.resolved && e.taskId === t.id);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'cleanup');
  assert.match(open[0].text, /worktree remove failed: locked/);
  require('../lib/errlog').resolveTask(t.id);

  t = card();
  wtcleanup.cleanupMergedCard = async () => { throw new Error('kaboom'); };
  await prwatch.sweep();
  assert.equal(t.status, 'done');
});
