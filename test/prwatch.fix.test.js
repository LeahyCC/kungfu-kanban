// Conflict-fixer cards (issue #70) must run at the parent card's permission
// mode, not a hardcoded acceptEdits that permission-blocks compound Bash.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

require('./helpers/temp-data-dir');

// prwatch destructures findWorktree/run from prflow at load, so stub them first.
const prflow = require('../lib/prflow');
prflow.findWorktree = async () => ({ path: os.tmpdir(), branch: 'worktree-kanban-x' });
prflow.run = async () => ({
  ok: true,
  out: JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', baseRefName: 'main' }),
});
const runner = require('../lib/runner');
const started = [];
runner.startTask = (id) => started.push(id);

const { state } = require('../lib/store');
const { maybeFix, fixerPermissionMode } = require('../lib/prwatch');

function parent(overrides = {}) {
  return { id: `p-${Math.random().toString(36).slice(2)}`, title: 'Parent', status: 'review', cwd: os.tmpdir(), prUrl: 'https://github.com/x/y/pull/1', ...overrides };
}

async function spawnFixer(task) {
  state.tasks.push(task);
  await maybeFix(task, {});
  return state.tasks.find((x) => x.fixesTaskId === task.id);
}

test('fixer inherits the parent card permission mode', async () => {
  const fix = await spawnFixer(parent({ permissionMode: 'bypassPermissions' }));
  assert.equal(fix.permissionMode, 'bypassPermissions');
  assert.ok(started.includes(fix.id));
});

test('fixer falls back to settings.defaultPermissionMode when the parent has none', async () => {
  state.settings.defaultPermissionMode = 'auto';
  try {
    assert.equal((await spawnFixer(parent())).permissionMode, 'auto');
  } finally {
    delete state.settings.defaultPermissionMode;
  }
});

test('fixerPermissionMode: plan never carries over (a fixer must edit), last resort is acceptEdits', () => {
  delete state.settings.defaultPermissionMode;
  assert.equal(fixerPermissionMode({ permissionMode: 'plan' }), 'acceptEdits');
  assert.equal(fixerPermissionMode({}), 'acceptEdits');
  state.settings.defaultPermissionMode = 'dontAsk';
  try {
    assert.equal(fixerPermissionMode({ permissionMode: 'plan' }), 'dontAsk');
  } finally {
    delete state.settings.defaultPermissionMode;
  }
});
