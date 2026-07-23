// End-to-end wiring for the PR automation loop. The unit tests cover each
// piece; the bug this file exists for was the wiring BETWEEN them — a PR
// opened, checks reported, and nothing ever handed the card back, so green
// PRs sat unmerged until a human looked. Drives the real sweep() against a
// fake `gh` on PATH and asserts who gets called at each stage.
//
// Runs in its own process (node --test isolates files), so patching the
// manager/runner module objects here cannot leak into other suites.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-loop-'));
const FIXTURE = path.join(TMP, 'pr.json');
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'gh'), '#!/bin/sh\ncat "$GH_FIXTURE"\n', { mode: 0o755 });
process.env.GH_FIXTURE = FIXTURE;
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-data-'));

const store = require('../lib/store');
const manager = require('../lib/manager');
const runner = require('../lib/runner');
const prwatch = require('../lib/prwatch');

// A real repo with a real `kanban-aaaaaaaa` worktree: the CI fixer refuses to
// resume a session whose worktree is gone, so the happy path needs one.
const REPO = path.join(TMP, 'repo');
let invokes = [];
let followUps = [];

before(() => {
  fs.mkdirSync(REPO);
  // commit.gpgsign=false: the fixture repo has no reason to depend on the
  // developer's local signing setup — an expired/missing GPG key would
  // otherwise fail `commit` and take this whole suite down with it.
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: REPO, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(REPO, 'f'), 'x');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('worktree', 'add', '-q', '-b', 'kanban-aaaaaaaa', path.join(TMP, 'wt'));

  manager.invoke = (trigger) => invokes.push(trigger);
  manager.config = () => ({ triggers: { onFinish: true } });
  runner.followUp = (id, msg) => { followUps.push({ id, msg }); return { queued: true }; };
  runner.pumpQueue = () => {};
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const gh = (o) => fs.writeFileSync(FIXTURE, JSON.stringify(o));
const CHECK = (name, conclusion) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });

// Fresh board + fresh call log for each stage.
function card() {
  store.state.tasks.length = 0;
  invokes = [];
  followUps = [];
  const t = { id: 'aaaaaaaa-1111', title: 'Loop card', status: 'review', cwd: REPO, sessionId: 'sess-1', prUrl: 'https://github.com/x/y/pull/1' };
  store.state.tasks.push(t);
  return t;
}

test('sweep: CI still running holds the card — no verdict yet', async () => {
  const t = card();
  gh({ state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' }] });
  await prwatch.sweep();
  assert.equal(t.prChecks.pending, 1);
  assert.equal(invokes.length, 0);
});

test('sweep: checks going green hands the card to the Sensei exactly once', async () => {
  card();
  gh({ state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' }] });
  await prwatch.sweep();
  gh({ state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', statusCheckRollup: [CHECK('test', 'SUCCESS')] });
  await prwatch.sweep();
  assert.equal(invokes.length, 1);
  assert.match(invokes[0], /merge\/reject verdict/);
  await prwatch.sweep(); // unchanged — must not re-invoke
  assert.equal(invokes.length, 1);
});

test('sweep: red CI auto-fixes in the card\'s own session before any Sensei verdict', async () => {
  const t = card();
  gh({ state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', statusCheckRollup: [CHECK('test', 'FAILURE')] });
  try {
    await prwatch.sweep();
    assert.equal(followUps.length, 1);
    assert.match(followUps[0].msg, /--log-failed/);
    assert.equal(t.ciFixes, 1);
    assert.equal(invokes.length, 0, 'no verdict while the auto-fix is in flight');
  } finally {
    require('../lib/errlog').resolveTask(t.id);
  }
});

test('sweep: a conflicting PR is recorded and refused by merge_pr even with green CI', async () => {
  const t = card();
  gh({ state: 'OPEN', mergeable: 'CONFLICTING', baseRefName: 'main', statusCheckRollup: [CHECK('test', 'SUCCESS')] });
  await prwatch.sweep();
  assert.equal(t.prChecks.conflicting, true);
  const res = manager.executeAction({ type: 'merge_pr', taskId: t.id, reasoning: 'x' });
  assert.equal(res.note, 'PR has merge conflicts with its base — not merging');
});

test('sweep: a repo with no CI becomes decision-ready after the grace window', async () => {
  const t = card();
  gh({ state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', statusCheckRollup: [] });
  await prwatch.sweep();
  assert.equal(invokes.length, 0, 'still inside the grace window');
  t.prChecks.firstSeenAt = new Date(Date.now() - 11 * 60_000).toISOString();
  await prwatch.sweep();
  assert.equal(t.prChecks.noCi, true);
  assert.equal(invokes.length, 1);
});

test('sweep: an upstream merge ships the card', async () => {
  const t = card();
  gh({ state: 'MERGED', baseRefName: 'main', statusCheckRollup: [] });
  await prwatch.sweep();
  assert.equal(t.status, 'done');
  assert.ok(t.prMergedAt);
});
