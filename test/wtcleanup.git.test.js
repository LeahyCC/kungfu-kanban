// Real git, no stubs: claude --worktree creates card worktrees LOCKED, and a
// single `git worktree remove --force` refuses those. The stubbed suite could
// not see that, so this one drives the actual cleanup against a locked worktree.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-wtgit-data-'));
const { cleanupMergedCard } = require('../lib/wtcleanup');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-wtgit-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const git = (cwd, ...a) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

test('removes a locked worktree and its merged branch with real git', async () => {
  // a bare "origin" so fetch and `push --delete` have somewhere real to go
  const origin = path.join(TMP, 'origin.git');
  const repo = path.join(TMP, 'repo');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', 'origin', 'main');

  const wt = path.join(repo, '.claude', 'worktrees', 'kanban-cccccccc');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/cccccccc', wt);
  git(repo, 'worktree', 'lock', wt);
  git(repo, 'push', '-q', 'origin', 'feature/cccccccc'); // tip == main, so it counts as landed
  assert.match(git(repo, 'worktree', 'list'), /locked/);

  const r = await cleanupMergedCard({ id: 'cccccccc-1111', cwd: repo }, 'main', {
    findProcesses: async () => [], // no process scan: nothing runs in the fixture
    boardDir: TMP,
  });

  assert.deepEqual(r.problems, []);
  assert.ok(!fs.existsSync(wt), 'worktree folder is gone');
  assert.ok(!/cccccccc/.test(git(repo, 'worktree', 'list')));
  assert.equal(git(repo, 'branch', '--list', 'feature/cccccccc').trim(), '', 'local branch deleted');
  assert.equal(git(repo, 'ls-remote', '--heads', 'origin', 'feature/cccccccc').trim(), '', 'remote branch deleted');
});
