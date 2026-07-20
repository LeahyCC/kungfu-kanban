const { test } = require('node:test');
const assert = require('node:assert/strict');

const { nextRunnable, notifyGroupCompletions, buildPrompt, buildArgs } = require('../lib/runner');
const store = require('../lib/store');

function withTasks(tasks, fn) {
  store.state.tasks.push(...tasks);
  try {
    fn();
  } finally {
    store.state.tasks.length = store.state.tasks.length - tasks.length;
  }
}

// --- buildPrompt ---------------------------------------------------------

test('buildPrompt: plain task with no skills returns the prompt unchanged', () => {
  assert.equal(buildPrompt({ prompt: 'do the thing' }), 'do the thing');
});

test('buildPrompt: missing prompt falls back to an empty string', () => {
  assert.equal(buildPrompt({}), '');
});

test('buildPrompt: skills list is prepended as a "Use the following installed skill(s)" block', () => {
  const out = buildPrompt({ prompt: 'body', skills: ['kungfu-todo', 'ponytail'] });
  assert.match(out, /^Use the following installed skill\(s\)/);
  assert.match(out, /- kungfu-todo/);
  assert.match(out, /- ponytail/);
  assert.match(out, /\n\nbody$/);
});

test('buildPrompt: empty skills array does not add the skills block', () => {
  assert.equal(buildPrompt({ prompt: 'body', skills: [] }), 'body');
});

test('buildPrompt: skillsAuto prepends the "review your installed skills" line', () => {
  const out = buildPrompt({ prompt: 'body', skillsAuto: true });
  assert.match(out, /^Review your installed skills/);
  assert.match(out, /\n\nbody$/);
});

test('buildPrompt: skills + skillsAuto combine, skillsAuto wraps outermost', () => {
  const out = buildPrompt({ prompt: 'body', skills: ['x'], skillsAuto: true });
  const expected =
    'Review your installed skills and use any that are genuinely relevant to this task via the Skill tool.\n\n' +
    'Use the following installed skill(s) via the Skill tool where relevant to this task:\n- x\n\nbody';
  assert.equal(out, expected);
});

// --- buildArgs -------------------------------------------------------------

test('buildArgs: minimal task produces just -p/--output-format/--verbose', () => {
  const args = buildArgs({ id: 'abc', prompt: 'hi', model: 'default' }, null);
  assert.deepEqual(args, ['-p', 'hi', '--output-format', 'stream-json', '--verbose']);
});

test('buildArgs: effModel wins over task.model when both are given', () => {
  const args = buildArgs({ id: 'abc', prompt: 'hi', model: 'opus' }, 'sonnet');
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
});

test('buildArgs: falls back to task.model when no effModel is given', () => {
  const args = buildArgs({ id: 'abc', prompt: 'hi', model: 'haiku' }, null);
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
});

test('buildArgs: "default" model (from either source) never adds --model', () => {
  assert.ok(!buildArgs({ id: 'a', prompt: 'p', model: 'default' }, 'default').includes('--model'));
  assert.ok(!buildArgs({ id: 'a', prompt: 'p', model: 'default' }, null).includes('--model'));
});

test('buildArgs: effort is only appended when set and not "default"', () => {
  assert.ok(!buildArgs({ id: 'a', prompt: 'p', effort: 'default' }, null).includes('--effort'));
  assert.ok(!buildArgs({ id: 'a', prompt: 'p' }, null).includes('--effort'));
  const args = buildArgs({ id: 'a', prompt: 'p', effort: 'high' }, null);
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

test('buildArgs: permissionMode and agent are appended only when present', () => {
  const bare = buildArgs({ id: 'a', prompt: 'p' }, null);
  assert.ok(!bare.includes('--permission-mode'));
  assert.ok(!bare.includes('--agent'));
  const full = buildArgs({ id: 'a', prompt: 'p', permissionMode: 'plan', agent: 'explore' }, null);
  assert.equal(full[full.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(full[full.indexOf('--agent') + 1], 'explore');
});

test('buildArgs: worktree true adds --worktree kanban-<id8prefix> and --add-dir when cwd is set', () => {
  const args = buildArgs({ id: 'abcdef1234567890', prompt: 'p', worktree: true, cwd: '/repo' }, null);
  assert.equal(args[args.indexOf('--worktree') + 1], 'kanban-abcdef12');
  assert.equal(args[args.indexOf('--add-dir') + 1], '/repo');
});

test('buildArgs: worktree true without cwd adds --worktree but no --add-dir', () => {
  const args = buildArgs({ id: 'abcdef1234567890', prompt: 'p', worktree: true }, null);
  assert.ok(args.includes('--worktree'));
  assert.ok(!args.includes('--add-dir'));
});

test('buildArgs: worktree false/absent never adds --worktree or --add-dir even with cwd set', () => {
  const args = buildArgs({ id: 'a', prompt: 'p', cwd: '/repo' }, null);
  assert.ok(!args.includes('--worktree'));
  assert.ok(!args.includes('--add-dir'));
});

// --- nextRunnable full table -------------------------------------------------

test('nextRunnable: returns null when nothing is queued', () => {
  assert.equal(nextRunnable(), null);
});

test('nextRunnable: skips a queued card whose deps are unmet', () => {
  const dep = { id: 'dep', status: 'backlog' };
  const blocked = { id: 'blocked', status: 'queued', deps: ['dep'] };
  withTasks([dep, blocked], () => {
    assert.equal(nextRunnable(), null);
  });
});

test('nextRunnable: FIFO — among equal priority ungrouped cards, the older (later in array) one wins', () => {
  const newer = { id: 'newer', status: 'queued', priority: 0 };
  const older = { id: 'older', status: 'queued', priority: 0 };
  // state.tasks is newest-first in real use; pushing newer then older puts
  // "older" at the highest index, which nextRunnable visits first.
  withTasks([newer, older], () => {
    assert.equal(nextRunnable().id, 'older');
  });
});

test('nextRunnable: higher priority wins over FIFO order', () => {
  const older = { id: 'older', status: 'queued', priority: 0 };
  const newerHighPriority = { id: 'newer', status: 'queued', priority: 3 };
  withTasks([newerHighPriority, older], () => {
    assert.equal(nextRunnable().id, 'newer');
  });
});

test('nextRunnable: a busy group (member running) blocks every queued card in that group', () => {
  const busy = { id: 'g-running', status: 'running', group: 'batch-1' };
  const a = { id: 'g-a', status: 'queued', group: 'batch-1' };
  const b = { id: 'g-b', status: 'queued', group: 'batch-1' };
  withTasks([busy, a, b], () => {
    assert.equal(nextRunnable(), null);
  });
});

test('nextRunnable: a "stopping" member also counts as occupying the group lane', () => {
  const stopping = { id: 'g-stop', status: 'stopping', group: 'batch-1' };
  const a = { id: 'g-a', status: 'queued', group: 'batch-1' };
  withTasks([stopping, a], () => {
    assert.equal(nextRunnable(), null);
  });
});

test('nextRunnable: once the group lane frees, a queued member becomes runnable', () => {
  const done = { id: 'g-running', status: 'done', group: 'batch-1' };
  const a = { id: 'g-a', status: 'queued', group: 'batch-1' };
  const b = { id: 'g-b', status: 'queued', group: 'batch-1' };
  withTasks([done, a, b], () => {
    const picked = nextRunnable();
    assert.ok(picked === a || picked === b);
  });
});

test('nextRunnable: a card from a group that already has progress is preferred over a fresh group, regardless of visit order or priority', () => {
  const progressDone = { id: 'a-done', status: 'done', group: 'A' };
  const progressQueued = { id: 'a-queued', status: 'queued', group: 'A', priority: 0 };
  const freshQueued = { id: 'b-queued', status: 'queued', group: 'B', priority: 3 };
  withTasks([progressDone, progressQueued, freshQueued], () => {
    assert.equal(nextRunnable().id, 'a-queued');
  });
  // Same outcome with visit order reversed.
  withTasks([freshQueued, progressQueued, progressDone], () => {
    assert.equal(nextRunnable().id, 'a-queued');
  });
});

test('nextRunnable: ungrouped queued cards are never treated as "in progress"', () => {
  const ungrouped = { id: 'u', status: 'queued', priority: 0 };
  const groupedFresh = { id: 'g', status: 'queued', group: 'G', priority: 0 };
  withTasks([ungrouped, groupedFresh], () => {
    // neither has progress, so it falls through to FIFO (ungrouped pushed first
    // -> lower index -> visited second -> ungrouped is "newer"); grouped (pushed
    // second, higher index) is visited first and wins the FIFO tie.
    assert.equal(nextRunnable().id, 'g');
  });
});

// --- notifyGroupCompletions edge cases ---------------------------------------

test('notifyGroupCompletions: a partially-done group is not stamped', () => {
  const a = { id: 'p-a', status: 'done', group: 'partial', finishedAt: '2026-01-01T00:00:00Z' };
  const b = { id: 'p-b', status: 'queued', group: 'partial' };
  withTasks([a, b], () => {
    notifyGroupCompletions();
    assert.equal(a.groupNotified, undefined);
  });
});

test('notifyGroupCompletions: stamps the group once and does not re-fire on later pumps', () => {
  store.state.settings.notifyMac = false;
  const a = { id: 'gc-a', status: 'done', group: 'batch-x', finishedAt: '2026-01-01T00:00:00Z' };
  const b = { id: 'gc-b', status: 'done', group: 'batch-x', finishedAt: '2026-01-02T00:00:00Z' };
  withTasks([a, b], () => {
    notifyGroupCompletions();
    assert.ok(a.groupNotified || b.groupNotified);
    const stamped = { a: a.groupNotified, b: b.groupNotified };
    notifyGroupCompletions();
    assert.deepEqual({ a: a.groupNotified, b: b.groupNotified }, stamped);
  });
});

test('notifyGroupCompletions: stamps specifically the last-finished member of the group', () => {
  const a = { id: 'lf-a', status: 'done', group: 'lf', finishedAt: '2026-01-01T00:00:00Z' };
  const b = { id: 'lf-b', status: 'done', group: 'lf', finishedAt: '2026-03-01T00:00:00Z' };
  const c = { id: 'lf-c', status: 'done', group: 'lf', finishedAt: '2026-02-01T00:00:00Z' };
  withTasks([a, b, c], () => {
    notifyGroupCompletions();
    assert.equal(b.groupNotified, true);
    assert.equal(a.groupNotified, undefined);
    assert.equal(c.groupNotified, undefined);
  });
});

test('notifyGroupCompletions: a group with one member already stamped is skipped entirely (no double-stamping the rest)', () => {
  const a = { id: 'al-a', status: 'done', group: 'already', finishedAt: '2026-01-01T00:00:00Z', groupNotified: true };
  const b = { id: 'al-b', status: 'done', group: 'already', finishedAt: '2026-01-02T00:00:00Z' };
  withTasks([a, b], () => {
    notifyGroupCompletions();
    assert.equal(b.groupNotified, undefined);
  });
});

test('notifyGroupCompletions: ungrouped tasks and an empty board are ignored without error', () => {
  const ungrouped = { id: 'ng', status: 'done', finishedAt: '2026-01-01T00:00:00Z' };
  withTasks([ungrouped], () => {
    assert.doesNotThrow(() => notifyGroupCompletions());
  });
});
