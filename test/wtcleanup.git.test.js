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

// claude --worktree kanban-<id> creates branch worktree-kanban-<id>; the agent
// then switches to its own branch, so that original branch was left behind
// after every merge.
function repoWithCard(id8) {
  const dir = fs.mkdtempSync(path.join(TMP, 'orig-'));
  const origin = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  git(repo, 'add', 'f');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  const wt = path.join(repo, '.claude', 'worktrees', `kanban-${id8}`);
  git(repo, 'worktree', 'add', '-q', '-b', `worktree-kanban-${id8}`, wt);
  git(wt, 'checkout', '-q', '-b', `feature/${id8}`);
  git(repo, 'push', '-q', 'origin', `feature/${id8}`);
  return { repo, wt };
}

test('deletes the worktree\'s original branch when it holds nothing beyond base', async () => {
  const { repo } = repoWithCard('dddddddd');
  const r = await cleanupMergedCard({ id: 'dddddddd-1111', cwd: repo }, 'main', { findProcesses: async () => [], boardDir: TMP });
  assert.deepEqual(r.problems, []);
  assert.ok(r.removed.includes('local branch worktree-kanban-dddddddd'));
  assert.equal(git(repo, 'branch', '--list', 'worktree-kanban-*').trim(), '');
});

test('keeps the original branch when it has commits nobody shipped', async () => {
  const { repo } = repoWithCard('eeeeeeee');
  git(repo, 'checkout', '-q', 'worktree-kanban-eeeeeeee'); // free now the agent switched away
  fs.writeFileSync(path.join(repo, 'g'), 'y');
  git(repo, 'add', 'g');
  git(repo, 'commit', '-qm', 'stray');
  git(repo, 'checkout', '-q', 'main');
  const r = await cleanupMergedCard({ id: 'eeeeeeee-1111', cwd: repo }, 'main', { findProcesses: async () => [], boardDir: TMP });
  assert.match(git(repo, 'branch', '--list', 'worktree-kanban-eeeeeeee'), /worktree-kanban-eeeeeeee/);
  assert.ok(r.notes.some((n) => /kept worktree-kanban-eeeeeeee: it has 1 commit/.test(n)));
});

test('a folder git leaves behind after remove (node_modules, .next) is deleted', async () => {
  const { repo, wt } = repoWithCard('ffffffff');
  const prflow = require('../lib/prflow');
  // Real git, then put back what a locked pnpm install leaves on Windows.
  const run = async (cmd, args, cwd, t) => {
    const res = await prflow.run(cmd, args, cwd, t);
    if (args[0] === 'worktree' && args[1] === 'remove' && res.ok) {
      fs.mkdirSync(path.join(wt, 'node_modules', '.pnpm', 'next'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'node_modules', '.pnpm', 'next', 'index.js'), '');
      fs.mkdirSync(path.join(wt, '.next', 'cache'), { recursive: true });
    }
    return res;
  };
  const r = await cleanupMergedCard({ id: 'ffffffff-1111', cwd: repo }, 'main', { run, findProcesses: async () => [], boardDir: TMP });
  assert.deepEqual(r.problems, []);
  assert.ok(!fs.existsSync(wt), 'leftover folder deleted');
  assert.ok(r.removed.some((x) => /leftover folder/.test(x)));
});

// The real process finder: git prints H:/a/b, Windows command lines hold H:\a\b.
test('defaultFindProcesses finds a process in the worktree whichever slashes git used', { timeout: 60_000 }, async () => {
  const { defaultFindProcesses } = require('../lib/wtcleanup');
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(TMP, 'proc-'));
  const native = path.resolve(dir);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', native], { cwd: native, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 500));
    const found = await defaultFindProcesses(native.replace(/\\/g, '/'));
    assert.ok(found.some((p) => p.pid === child.pid), `pid ${child.pid} in ${JSON.stringify(found)}`);
  } finally {
    child.kill('SIGKILL');
  }
});
