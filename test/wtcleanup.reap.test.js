// End-of-run process reap and the leftover-folder step, with git, processes
// and the filesystem stubbed. Real-git versions live in wtcleanup.git.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'kfk-wtr-'));
const { cleanupMergedCard, reapRun, parseLsof, parseTabbed } = require('../lib/wtcleanup');

const REPO = path.resolve('/tmp/repo');
const WT = path.join(REPO, '.claude', 'worktrees', 'kanban-aaaaaaaa');
const task = { id: 'aaaaaaaa-1111', cwd: REPO };

function harness({ pids = [] } = {}) {
  const killed = [];
  const deps = {
    run: async (cmd, args) => (args[0] === 'rev-parse' ? { ok: true, out: 'deadbeef', err: '' } : { ok: true, out: '', err: '' }),
    findWorktree: async () => ({ path: WT, branch: 'feature/a' }),
    findProcesses: async () => pids,
    kill: (pid) => { killed.push(pid); return true; },
    selfPid: 4242,
    boardDir: path.resolve('/elsewhere'),
  };
  return { killed, deps };
}

// --- leftover folder after a successful remove (Windows, pnpm node_modules) --

test('a folder left behind after git worktree remove is deleted', async () => {
  const h = harness();
  const present = new Set([WT]);
  let removed = null;
  h.deps.exists = (p) => present.has(p);
  h.deps.rm = (p) => { removed = p; present.delete(p); };
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.equal(removed, WT);
  assert.ok(r.removed.includes(`leftover folder ${WT}`));
  assert.deepEqual(r.problems, []);
});

test('a leftover folder that will not delete is reported', async () => {
  const h = harness();
  h.deps.exists = (p) => p === WT;
  h.deps.rm = () => { throw new Error('EBUSY: resource busy or locked'); };
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.ok(r.problems.some((p) => /could not be deleted: EBUSY/.test(p)));
});

test('a leftover folder that still holds .git is never deleted', async () => {
  const h = harness();
  let rmCalled = false;
  h.deps.exists = (p) => p === WT || p === path.join(WT, '.git');
  h.deps.rm = () => { rmCalled = true; };
  const r = await cleanupMergedCard(task, 'main', h.deps);
  assert.equal(rmCalled, false);
  assert.ok(r.problems.some((p) => /still holds a \.git entry/.test(p)));
});

// --- end-of-run reap: dev servers an agent left running ---------------------

test('reapRun: kills what runs in the worktree, names it, spares the board', async () => {
  const h = harness({ pids: [{ pid: 31, name: 'node.exe' }, { pid: 4242, name: 'node.exe' }] });
  const r = await reapRun({ ...task, worktree: true }, h.deps);
  assert.deepEqual(h.killed, [31]);
  assert.deepEqual(r.notes, ['killed process 31 (node.exe) running in the worktree']);
});

test('reapRun: a non-worktree card is never reaped (its cwd is the user\'s checkout)', async () => {
  const h = harness();
  let looked = false;
  h.deps.findProcesses = async () => { looked = true; return [31]; };
  await reapRun({ ...task, worktree: false }, h.deps);
  assert.equal(looked, false);
  assert.deepEqual(h.killed, []);
});

test('reapRun: an open board terminal in the worktree keeps its processes', async () => {
  const h = harness({ pids: [31] });
  h.deps.terminals = [{ cwd: path.join(WT, 'src'), exited: false }];
  const r = await reapRun({ ...task, worktree: true }, h.deps);
  assert.deepEqual(h.killed, []);
  assert.ok(r.notes.some((n) => /terminal is open/.test(n)));
});

test('reapRun: never the main checkout', async () => {
  const h = harness({ pids: [31] });
  h.deps.findWorktree = async () => ({ path: REPO, branch: 'main' });
  await reapRun({ ...task, worktree: true }, h.deps);
  assert.deepEqual(h.killed, []);
});

test('reapRun: a crashing finder is reported, not thrown', async () => {
  const h = harness();
  h.deps.findProcesses = async () => { throw new Error('boom'); };
  const r = await reapRun({ ...task, worktree: true }, h.deps);
  assert.ok(r.problems.some((p) => /crashed: boom/.test(p)));
});

test('process list parsers', () => {
  assert.deepEqual(parseTabbed('12\tnode.exe\r\n34\tcmd.exe\r\n\r\n'), [{ pid: 12, name: 'node.exe' }, { pid: 34, name: 'cmd.exe' }]);
  assert.deepEqual(parseLsof('p12\ncnode\np34\ncnext-server\n'), [{ pid: 12, name: 'node' }, { pid: 34, name: 'next-server' }]);
  assert.deepEqual(parseLsof(''), []);
});
