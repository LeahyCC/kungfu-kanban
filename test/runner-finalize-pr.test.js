// Regression for #85: finalize() skipped openPr for any card with task.error
// (usually a permission block), so a card that committed real work, or opened
// its own PR, ended with no prUrl and every `after:` dependant waited forever.
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'kfk-finalize-pr-')
);
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
const prflow = require('../lib/prflow');
const { finalize } = require('../lib/runner');

const realRun = prflow.run;
let calls;

const NEW_PR = { ok: true, out: 'https://github.com/o/r/pull/9', err: '' };

// Stands in for git/gh: answers the handful of commands openPr issues.
function installFakeRun({ ahead = '2', dirty = '', ghCreate = NEW_PR }) {
  calls = [];
  prflow.run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const ok = (out = '') => ({ ok: true, out, err: '' });
    if (cmd === 'git' && args[0] === 'worktree') {
      return ok('worktree /tmp/wt\nbranch refs/heads/worktree-kanban-fin00001\n');
    }
    if (cmd === 'git' && args[0] === 'status') return ok(dirty);
    if (cmd === 'git' && args[0] === 'branch') return ok('main');
    if (cmd === 'git' && args[0] === 'ls-remote') return ok('abc refs/heads/main');
    if (cmd === 'git' && args[0] === 'rev-list') return ok(ahead);
    if (cmd === 'gh' && args[1] === 'create') return ghCreate;
    return ok();
  };
}

function addTask(extra) {
  const task = {
    id: 'fin00001-aaaa', title: 'A card', cwd: '/tmp/repo', worktree: true, openPr: true,
    status: 'review', ...extra,
  };
  store.state.tasks.push(task);
  return task;
}

beforeEach(() => { store.state.tasks.length = 0; });
after(() => { prflow.run = realRun; });

test('errored card with commits ahead still gets its PR; error and block flag survive', async () => {
  installFakeRun({});
  const task = addTask({ error: 'Blocked on permission', permissionBlocked: ['Bash rm x'] });
  await finalize(task);
  assert.equal(task.prUrl, 'https://github.com/o/r/pull/9');
  assert.equal(task.error, 'Blocked on permission');
  assert.deepEqual(task.permissionBlocked, ['Bash rm x']);
});

test('errored card with no commits ahead opens no PR', async () => {
  installFakeRun({ ahead: '0' });
  const task = addTask({ error: 'Blocked on permission' });
  await finalize(task);
  assert.equal(task.prUrl, undefined);
  assert.ok(!calls.some((c) => c.startsWith('gh pr create')));
  assert.ok(!calls.some((c) => c.startsWith('git push')));
});

test('errored card: uncommitted leftovers are not swept into a new commit', async () => {
  installFakeRun({ dirty: ' M half-done.js' });
  const task = addTask({ error: 'boom' });
  await finalize(task);
  assert.ok(!calls.some((c) => c.startsWith('git add') || c.startsWith('git commit')));
  assert.equal(task.prUrl, 'https://github.com/o/r/pull/9');
});

test('clean card still commits leftovers (unchanged behaviour)', async () => {
  installFakeRun({ dirty: ' M a.js' });
  const task = addTask({});
  await finalize(task);
  assert.ok(calls.some((c) => c.startsWith('git commit')));
  assert.equal(task.prUrl, 'https://github.com/o/r/pull/9');
});

test('agent opened the PR itself, then errored: the existing URL lands on the task', async () => {
  installFakeRun({
    ghCreate: {
      ok: false, out: '',
      err: 'a pull request for branch "worktree-kanban-fin00001" into branch "main" already exists:\nhttps://github.com/o/r/pull/7',
    },
  });
  const task = addTask({ error: 'Blocked on permission', permissionBlocked: ['Bash x'] });
  await finalize(task);
  assert.equal(task.prUrl, 'https://github.com/o/r/pull/7');
  assert.equal(task.error, 'Blocked on permission');
});

test('cards that did not ask for a PR are untouched', async () => {
  installFakeRun({});
  const task = addTask({ error: 'boom', openPr: false });
  await finalize(task);
  assert.equal(calls.length, 0);
});
