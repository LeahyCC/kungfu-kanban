// Publishing a contract launches a queued card that `uses:` it, straight away
// instead of on the next pump. The publisher reads from a REAL git worktree
// (see publish.test.js); only the `claude` spawn is faked, so no agent runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const cp = require('child_process');

const realSpawn = cp.spawn;
const claudeSpawns = [];
cp.spawn = (cmd, args, opts) => {
  if (cmd !== 'claude') return realSpawn(cmd, args, opts);
  claudeSpawns.push(args);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, write() {}, end() {} };
  child.pid = 99998;
  child.kill = () => {};
  child.unref = () => {};
  return child;
};

require('./helpers/temp-data-dir');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const store = require('../lib/store');
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;
store.state.settings.maxRunMinutes = 0; // no watchdog timer holding the process open
store.state.settings.maxConcurrent = 4;

const publish = require('../lib/publish');
const { nextRunnable } = require('../lib/runner');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-uses-launch-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const git = (cwd, ...a) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

// A repo with a locked card worktree for `id`, the way the board leaves them.
function makeRepo(id) {
  const repo = path.join(TMP, `repo-${id.slice(0, 8)}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  const wt = path.join(repo, '.claude', 'worktrees', `kanban-${id.slice(0, 8)}`);
  git(repo, 'worktree', 'add', '-q', '-b', `feature/${id.slice(0, 8)}`, wt);
  git(repo, 'worktree', 'lock', wt);
  return { repo, wt };
}

test('publishing a contract launches the queued card waiting on it; a pinned later version keeps waiting', async () => {
  const pubId = 'aaaa1111-0000-4000-8000-000000000001';
  const { repo, wt } = makeRepo(pubId);
  fs.writeFileSync(path.join(wt, 'api.md'), 'GET /things');
  const publisher = {
    id: pubId, title: 'Publisher', cwd: repo, worktree: true, status: 'review', error: null,
    publishes: [{ name: 'launch-api', path: 'api.md' }],
  };
  const waiter = {
    id: 'bbbb2222-0000-4000-8000-000000000002', title: 'Waiter', cwd: TMP, status: 'queued', deps: [],
    prompt: 'build against the api', uses: [{ name: 'launch-api', version: null }],
  };
  const pinned = {
    id: 'cccc3333-0000-4000-8000-000000000003', title: 'Pinned', cwd: TMP, status: 'queued', deps: [],
    prompt: 'needs v2', uses: [{ name: 'launch-api', version: 2 }],
  };
  store.state.tasks.push(publisher, waiter, pinned);

  assert.equal(nextRunnable(), null, 'nothing is launchable before the contract exists');

  const out = await publish.publishTask(publisher);
  assert.equal(out.published.length, 1);
  assert.equal(waiter.status, 'running', 'the publish itself pumped the queue');
  assert.equal(pinned.status, 'queued', 'v1 does not satisfy a pin on v2');

  // A same-content publish creates nothing and launches nothing.
  await publish.publishTask(publisher);
  assert.equal(pinned.status, 'queued');

  fs.writeFileSync(path.join(wt, 'api.md'), 'GET /things\nPOST /things');
  await publish.publishTask(publisher);
  assert.equal(pinned.status, 'running', 'v2 releases the pinned card');

  // The launch goes through the (faked) claude spawn after its pre-launch step.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(claudeSpawns.length, 2);
});
