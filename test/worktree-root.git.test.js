// settings.worktreeRoot: the board makes a card's worktree under a shared
// folder (<root>/<repo>/kanban-<id>) and runs claude inside it, because
// `claude --worktree` only takes a name and always nests inside the repo.
// Real git; only the claude spawn is faked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const cp = require('child_process');

const realSpawn = cp.spawn;
const spawns = [];
cp.spawn = (cmd, args, opts) => {
  if (cmd !== 'claude') return realSpawn(cmd, args, opts);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, write() {}, end() {} };
  child.pid = 99996;
  child.kill = () => {};
  child.unref = () => {};
  spawns.push({ args, cwd: opts && opts.cwd, child });
  return child;
};

require('./helpers/temp-data-dir');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const store = require('../lib/store');
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;
store.state.settings.maxRunMinutes = 0;
store.state.settings.maxConcurrent = 4;
const runner = require('../lib/runner');
const prflow = require('../lib/prflow');
runner.reapRun = async () => ({ removed: [], problems: [], notes: [] });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-wtroot-'));
const ROOT = path.join(TMP, 'shared', '.worktrees');
after(() => {
  delete store.state.settings.worktreeRoot;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const git = (cwd, ...a) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

function makeRepo(name) {
  const origin = path.join(TMP, `${name}.git`);
  const repo = path.join(TMP, name);
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env.local\n');
  fs.writeFileSync(path.join(repo, '.worktreeinclude'), '.env.local\n');
  fs.writeFileSync(path.join(repo, '.env.local'), 'SECRET=1\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git(repo, 'add', '.gitignore', '.worktreeinclude', 'a.txt');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  return repo;
}

// macOS tmp lives behind /var -> /private/var; git reports the real path.
const real = (p) => fs.realpathSync(p);

async function until(fn) {
  for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fn(), 'condition never became true');
}

beforeEach(() => {
  store.state.tasks.length = 0;
  spawns.length = 0;
  store.state.settings.worktreeRoot = ROOT;
});

test('a worktree card launches in <root>/<repo>/kanban-<id>, not inside the repo', async () => {
  const repo = makeRepo('ACE');
  const t = { id: 'r00t0001-aaaa', title: 'c', prompt: 'p', cwd: repo, worktree: true, status: 'backlog' };
  store.state.tasks.unshift(t);
  runner.startTask(t.id);
  await until(() => spawns.length === 1);

  const want = path.join(ROOT, 'ACE', 'kanban-r00t0001');
  assert.equal(real(spawns[0].cwd), real(want), 'claude runs inside the shared-folder worktree');
  assert.ok(!spawns[0].args.includes('--worktree'), 'no claude --worktree');
  assert.ok(spawns[0].args.includes('--add-dir'), 'the repo stays readable');
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees')), 'nothing inside the repo');
  assert.equal(fs.readFileSync(path.join(want, '.env.local'), 'utf8'), 'SECRET=1\n', '.worktreeinclude files copied, like claude --worktree');

  const wt = await prflow.findWorktree(repo, 'kanban-r00t0001');
  assert.equal(wt.branch, 'worktree-kanban-r00t0001');

  spawns[0].child.emit('close', 0);
  await until(() => t.status === 'review');
});

test('a retry reuses the card\'s worktree instead of making a second one', async () => {
  const repo = makeRepo('Reuse');
  const t = { id: 'r00t0002-aaaa', title: 'c', prompt: 'p', cwd: repo, worktree: true, status: 'backlog' };
  store.state.tasks.unshift(t);
  runner.startTask(t.id);
  await until(() => spawns.length === 1);
  spawns[0].child.emit('close', 0);
  await until(() => t.status === 'review');

  runner.startTask(t.id);
  await until(() => spawns.length === 2);
  assert.equal(real(spawns[1].cwd), real(spawns[0].cwd));
  spawns[1].child.emit('close', 0);
  await until(() => t.status === 'review');
});

test('a worktree that cannot be made fails the launch with git\'s reason', async () => {
  const notRepo = fs.mkdtempSync(path.join(TMP, 'plain-'));
  const t = { id: 'r00t0003-aaaa', title: 'c', prompt: 'p', cwd: notRepo, worktree: true, status: 'backlog' };
  store.state.tasks.unshift(t);
  runner.startTask(t.id);
  await until(() => t.status === 'review');
  assert.equal(spawns.length, 0);
  assert.match(t.error, /^Failed to launch: .*not inside a git repository/);
  assert.equal(runner.isRunning(t.id), false, 'the slot is released');
});

test('unset root keeps claude --worktree', () => {
  delete store.state.settings.worktreeRoot;
  const args = runner.buildArgs({ id: 'abcdef1234567890', prompt: 'p', worktree: true, cwd: '/repo' }, null);
  assert.ok(args.includes('--worktree'));
});

test('normalizeWorktreeRoot: absolute or ~, empty clears, relative refused', () => {
  assert.equal(runner.normalizeWorktreeRoot(''), '');
  assert.equal(runner.normalizeWorktreeRoot('~/dev/.worktrees'), path.join(os.homedir(), 'dev', '.worktrees'));
  assert.equal(runner.normalizeWorktreeRoot(path.join(TMP, 'x')), path.join(TMP, 'x'));
  assert.throws(() => runner.normalizeWorktreeRoot('relative/dir'), /absolute path/);
});
