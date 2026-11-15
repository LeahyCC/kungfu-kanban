// Real git for the PR flow's commit step (2026-11-15, an ACE batch): agents
// commit and open their own PR, then the board's fallback commit failed and
// its `return` skipped the push and the PR lookup, so six cards sat in Review
// with no PR attached. The commit also swept untracked files in with
// `git add -A` and retried with --no-verify. Only `gh` is stubbed here.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-prcommit-data-'));
const store = require('../lib/store');
const prflow = require('../lib/prflow');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-prcommit-'));
const realRun = prflow.run;
after(() => {
  prflow.run = realRun;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const git = (cwd, ...a) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

let n = 0;
let calls;
let ghPrList; // what `gh pr list --head` answers

// A repo with a bare origin and a card worktree whose agent already committed
// on its own feature branch, the way claude --worktree cards leave it.
function fixture() {
  const dir = path.join(TMP, String(++n));
  const origin = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  const id = `c0mm1t0${n}-aaaa`;
  const wt = path.join(repo, '.claude', 'worktrees', `kanban-${id.slice(0, 8)}`);
  git(repo, 'worktree', 'add', '-q', '-b', `worktree-kanban-${id.slice(0, 8)}`, wt);
  git(wt, 'checkout', '-q', '-b', 'feature/agent-work');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
  git(wt, 'commit', '-qam', 'Agent commit');
  const task = { id, title: 'A card', cwd: repo, worktree: true, openPr: true, status: 'review', createdAt: '2026-01-01T00:00:00Z' };
  store.state.tasks.push(task);
  return { repo, wt, task, origin };
}

function hook(repo, name, body) {
  const p = path.join(repo, '.git', 'hooks', name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
}

beforeEach(() => {
  store.state.tasks.length = 0;
  calls = [];
  ghPrList = '[]';
  prflow.run = async (cmd, args, cwd, timeout) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd !== 'gh') return realRun(cmd, args, cwd, timeout);
    if (args[0] === 'pr' && args[1] === 'list') return { ok: true, out: ghPrList, err: '' };
    if (args[0] === 'pr' && args[1] === 'create') return { ok: true, out: 'https://github.com/o/r/pull/99', err: '' };
    return { ok: false, out: '', err: 'not stubbed' };
  };
});

async function openPr(task) {
  const log = [];
  await prflow.openPr(task.id, (evt) => { if (evt.type === 'output') log.push(evt.entry); });
  return log;
}

test('untracked files are never committed, and the agent\'s own PR is attached', async () => {
  const { wt, task, origin } = fixture();
  fs.writeFileSync(path.join(wt, 'AGENTS.md'), 'auto-generated\n');
  ghPrList = JSON.stringify([{ url: 'https://github.com/o/r/pull/7', createdAt: '2026-02-01T00:00:00Z' }]);

  const log = await openPr(task);

  assert.equal(task.prUrl, 'https://github.com/o/r/pull/7');
  assert.ok(!calls.some((c) => c.startsWith('gh pr create')), 'no duplicate PR');
  assert.ok(!calls.some((c) => c === 'git add -A'), 'never git add -A');
  assert.equal(git(wt, 'log', '-1', '--format=%s').trim(), 'Agent commit', 'no fallback commit');
  assert.match(git(wt, 'status', '--porcelain'), /\?\? AGENTS\.md/, 'AGENTS.md is still untracked');
  assert.ok(log.some((e) => /left 1 untracked file\(s\) out of the commit: AGENTS\.md/.test(e.text)));
  assert.match(git(origin, 'branch', '--list', 'feature/agent-work'), /feature\/agent-work/, 'branch pushed');
});

test('a failing pre-commit hook is reported, never skipped, and the flow still pushes and opens the PR', async () => {
  const { repo, wt, task, origin } = fixture();
  hook(repo, 'pre-commit', 'echo "lint-staged: prettier failed" >&2; exit 1');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'three\n'); // tracked, uncommitted

  const log = await openPr(task);

  assert.ok(!calls.some((c) => c.includes('--no-verify')), 'never --no-verify');
  const err = log.find((e) => e.kind === 'error');
  assert.ok(err, 'commit failure is logged as an error');
  assert.match(err.text, /lint-staged: prettier failed/, 'the hook\'s real stderr is in the log');
  assert.match(git(wt, 'status', '--porcelain'), /M\s+a\.txt/, 'the change is left uncommitted');
  assert.match(git(origin, 'branch', '--list', 'feature/agent-work'), /feature\/agent-work/, 'the agent\'s commits were still pushed');
  assert.equal(task.prUrl, 'https://github.com/o/r/pull/99');
});

test('tracked leftovers are committed under the card title with no tool footer', async () => {
  const { wt, task } = fixture();
  fs.writeFileSync(path.join(wt, 'a.txt'), 'three\n');
  await openPr(task);
  assert.equal(git(wt, 'log', '-1', '--format=%B').trim(), 'A card');
  assert.equal(git(wt, 'status', '--porcelain').trim(), '');
});

test('a failing pre-push hook is not skipped; the agent\'s already-pushed PR still lands', async () => {
  const { repo, wt, task } = fixture();
  git(wt, 'push', '-q', 'origin', 'feature/agent-work'); // the agent pushed itself
  fs.writeFileSync(path.join(wt, 'a.txt'), 'three\n');
  git(wt, 'commit', '-qam', 'later commit');
  hook(repo, 'pre-push', 'echo "pre-push: typecheck failed" >&2; exit 1');
  ghPrList = JSON.stringify([{ url: 'https://github.com/o/r/pull/8', createdAt: '2026-02-01T00:00:00Z' }]);

  const log = await openPr(task);

  assert.ok(!calls.some((c) => c.includes('--no-verify')), 'never --no-verify');
  assert.ok(log.some((e) => e.kind === 'error' && /pre-push: typecheck failed/.test(e.text)));
  assert.equal(task.prUrl, 'https://github.com/o/r/pull/8');
});

test('failureText: git\'s stdout reason beats execFile\'s "Command failed" echo', () => {
  const t = prflow.failureText({ ok: false, out: 'nothing added to commit but untracked files present', err: 'Command failed: git commit -m x' });
  assert.equal(t, 'nothing added to commit but untracked files present');
  assert.equal(prflow.failureText({ ok: false, out: '', err: 'fatal: boom' }), 'fatal: boom');
});
