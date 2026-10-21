// prflow.mergePr (the board's merge button and the Sensei's merge_pr) moves a
// card from Review to Done. That move is the merge itself, not anyone
// approving the card, so it must not stamp doneAt: the flow report's done to
// merged time only means something for cards approved before they merged.
//
// execFile is stubbed BEFORE lib/prflow loads (it destructures it at require
// time) so no real `gh` runs.
const cp = require('child_process');

cp.execFile = (cmd, args, opts, cb) => {
  if (cmd === 'gh') cb(null, '', '');
  else cb(new Error(`unexpected ${cmd}`), '', '');
  return { kill() {} };
};

require('./helpers/temp-data-dir');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
store.state.settings.notifyMac = false;
const prflow = require('../lib/prflow');
const runner = require('../lib/runner');
runner.pumpQueue = () => {};

test('mergePr: a card merged straight from Review is done with prMergedAt but no doneAt', async () => {
  const t = { id: 'merge-1', title: 'm', status: 'review', cwd: '/x', prUrl: 'https://github.com/x/y/pull/1' };
  store.state.tasks.push(t);
  const res = await prflow.mergePr(t);
  assert.equal(res.ok, true);
  assert.equal(t.status, 'done');
  assert.ok(t.prMergedAt);
  assert.equal(t.doneAt, undefined);
});

test('mergePr: a card already approved keeps its approval time as doneAt', async () => {
  const t = { id: 'merge-2', title: 'm', status: 'done', doneAt: '2026-10-01T10:00:00.000Z', cwd: '/x', prUrl: 'https://github.com/x/y/pull/2' };
  store.state.tasks.push(t);
  await prflow.mergePr(t);
  assert.equal(t.doneAt, '2026-10-01T10:00:00.000Z');
  assert.ok(t.prMergedAt);
});
