// Post-merge worktree cleanup, with every git and process call stubbed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'kfk-wtc-'));
const { cleanupMergedCard } = require('../lib/wtcleanup');

const REPO = path.resolve('/tmp/repo');
const WT = path.join(REPO, '.claude', 'worktrees', 'kanban-aaaaaaaa');
const task = { id: 'aaaaaaaa-1111', cwd: REPO };

function harness({ ancestor = true, failOn = [], pids = [], killOk = true } = {}) {
  const calls = [];
  const killed = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const key = args.slice(0, 2).join(' ');
    const fail = failOn.find((f) => key.startsWith(f) || args.join(' ').startsWith(f));
    if (fail) return { ok: false, out: '', err: `stub failure: ${fail}` };
    if (args[0] === 'rev-parse') return { ok: true, out: 'deadbeef', err: '' };
    if (args[0] === 'merge-base') return { ok: ancestor, out: '', err: '' };
    return { ok: true, out: '', err: '' };
  };
  const deps = {
    run,
    findWorktree: async () => ({ path: WT, branch: 'kanban/aaaaaaaa' }),
    findProcesses: async () => pids,
    kill: (pid) => { killed.push(pid); return killOk; },
    selfPid: 4242,
    boardDir: REPO,
  };
  return { calls, killed, deps };
}

test('landed branch: kills stragglers, removes worktree, deletes both branches', async () => {
  const h = harness({ pids: [111, 4242, 222] });
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(h.killed, [111, 222]); // the board's own pid is never killed
  assert.ok(h.calls.includes('git fetch origin'));
  assert.ok(h.calls.includes('git merge-base --is-ancestor deadbeef origin/main'));
  assert.ok(h.calls.includes(`git worktree remove --force ${WT}`));
  assert.ok(h.calls.includes('git branch -D kanban/aaaaaaaa'));
  assert.ok(h.calls.includes('git push origin --delete kanban/aaaaaaaa'));
});

test('squash/rebase merge: trusts MERGED but keeps the local branch', async () => {
  const h = harness({ ancestor: false });
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.deepEqual(r.problems, []);
  assert.ok(!h.calls.some((c) => c.startsWith('git branch -D')));
  assert.ok(h.calls.some((c) => c.startsWith('git worktree remove')));
  assert.ok(h.calls.includes('git push origin --delete kanban/aaaaaaaa'));
  assert.ok(r.notes.some((n) => /not an ancestor/.test(n)));
});

test('failures are returned, never thrown, and later steps still run', async () => {
  const h = harness({ failOn: ['worktree remove', 'push origin'] });
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.equal(r.problems.length, 2);
  assert.ok(r.problems.some((p) => /worktree remove failed/.test(p)));
  assert.ok(r.problems.some((p) => /push origin --delete failed/.test(p)));
  // the worktree is still there, so its branch must not be deleted
  assert.ok(!h.calls.some((c) => c.startsWith('git branch -D')));
});

test('a kill that fails is reported', async () => {
  const h = harness({ pids: [9], killOk: false });
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.ok(r.problems.some((p) => /could not kill process 9/.test(p)));
});

test('a crashing dependency does not escape', async () => {
  const h = harness();
  h.deps.findProcesses = async () => { throw new Error('boom'); };
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.ok(r.problems.some((p) => /crashed: boom/.test(p)));
});

test('refuses to remove the main checkout or the board folder', async () => {
  const h = harness();
  h.deps.findWorktree = async () => ({ path: REPO, branch: 'main' });
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.equal(r.problems.length, 1);
  assert.ok(!h.calls.some((c) => c.startsWith('git worktree remove')));
});

test('worktree already gone: nothing to do, no error', async () => {
  const h = harness();
  h.deps.findWorktree = async () => null;
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(h.calls, []);
});
