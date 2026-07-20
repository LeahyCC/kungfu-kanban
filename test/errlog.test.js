const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const errlog = require('../lib/errlog');

// errlog keeps its `entries` array as module state and debounces writes to
// data/errors.json — this worktree's own, gitignored data dir, never the
// live board's (that runs from a separate install). Always wipe it after
// this file runs rather than "restore original content": a leftover file
// from an earlier interrupted run would otherwise get misread as real
// pre-existing data and preserved forever instead of cleaned up.
const FILE = path.join(__dirname, '..', 'data', 'errors.json');
after(async () => {
  // errlog.save() debounces writes 150ms out — the last test's cleanup calls
  // can leave one in flight. Wait it out first, or that write lands AFTER
  // this cleanup and silently recreates a bloated errors.json on disk.
  await new Promise((r) => setTimeout(r, 300));
  try { fs.unlinkSync(FILE); } catch {}
  try { fs.unlinkSync(FILE + '.bak'); } catch {}
});

function settle() {
  // errlog.save() debounces writes (and prune()) by 150ms; a few ms of slack.
  return new Promise((r) => setTimeout(r, 220));
}

// --- capture / dedupe --------------------------------------------------

test('capture: creates a new open entry with defaults', () => {
  const e = errlog.capture('run-failed', { taskId: 't-cap', taskTitle: 'Card', text: 'boom' });
  try {
    assert.equal(e.kind, 'run-failed');
    assert.equal(e.taskId, 't-cap');
    assert.equal(e.taskTitle, 'Card');
    assert.equal(e.text, 'boom');
    assert.equal(e.count, 1);
    assert.equal(e.resolved, false);
    assert.ok(e.id);
  } finally {
    errlog.resolveTask('t-cap');
  }
});

test('capture: an unrecognized kind falls back to "run-failed"', () => {
  const e = errlog.capture('totally-made-up', { taskId: 't-kind', text: 'x' });
  try {
    assert.equal(e.kind, 'run-failed');
  } finally {
    errlog.resolveTask('t-kind');
  }
});

test('capture: falsy text is a no-op — no entry created', () => {
  assert.equal(errlog.capture('run-failed', { taskId: 't-empty', text: '' }), null);
  assert.equal(errlog.capture('run-failed', { taskId: 't-empty' }), null);
});

test('capture: a repeat of the same open kind+taskId+text bumps count instead of adding a row', () => {
  const taskId = 't-dedupe';
  try {
    const first = errlog.capture('run-failed', { taskId, text: 'same failure' });
    const second = errlog.capture('run-failed', { taskId, text: 'same failure' });
    assert.equal(second.id, first.id);
    assert.equal(second.count, 2);
    assert.equal(errlog.list().filter((x) => x.taskId === taskId).length, 1);
  } finally {
    errlog.resolveTask(taskId);
  }
});

test('capture: differing kind, taskId, or text each produce a distinct entry', () => {
  const taskId = 't-distinct';
  try {
    errlog.capture('run-failed', { taskId, text: 'same failure' });
    errlog.capture('run-failed', { taskId, text: 'a different failure' });
    errlog.capture('permission', { taskId, text: 'same failure' });
    errlog.capture('run-failed', { taskId: 't-distinct-2', text: 'same failure' });
    assert.equal(errlog.list().filter((x) => x.taskId === taskId).length, 3);
  } finally {
    errlog.resolveTask(taskId);
    errlog.resolveTask('t-distinct-2');
  }
});

test('capture: text is clipped to 400 chars, detail to 1000', () => {
  const e = errlog.capture('run-failed', { taskId: 't-clip', text: 'x'.repeat(500), detail: 'y'.repeat(1500) });
  try {
    assert.equal(e.text.length, 400);
    assert.equal(e.detail.length, 1000);
  } finally {
    errlog.resolveTask('t-clip');
  }
});

// --- resolve / resolveAll / resolveTask / resolveKind -----------------------

test('resolve: marks an entry resolved with a resolvedAt/resolvedBy stamp', () => {
  const e = errlog.capture('run-failed', { taskId: 't-res', text: 'x' });
  const resolved = errlog.resolve(e.id, 'tester');
  assert.equal(resolved.id, e.id);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.resolvedBy, 'tester');
  assert.ok(resolved.resolvedAt);
});

test('resolve: an unknown id, or an already-resolved entry, returns null', () => {
  assert.equal(errlog.resolve('no-such-id'), null);
  const e = errlog.capture('run-failed', { taskId: 't-double-res', text: 'x' });
  errlog.resolve(e.id);
  assert.equal(errlog.resolve(e.id), null);
});

test('resolveAll: resolves every open entry and returns the count; a second call resolves nothing', () => {
  errlog.capture('run-failed', { taskId: 't-all-1', text: 'x' });
  errlog.capture('permission', { taskId: 't-all-2', text: 'y' });
  const n = errlog.resolveAll('bulk');
  assert.ok(n >= 2);
  assert.equal(errlog.resolveAll('bulk'), 0);
});

test('resolveTask: with kinds=null clears every open entry for that card', () => {
  const taskId = 't-clear-all';
  errlog.capture('run-failed', { taskId, text: 'a' });
  errlog.capture('permission', { taskId, text: 'b' });
  const n = errlog.resolveTask(taskId);
  assert.equal(n, 2);
  assert.equal(errlog.list().filter((x) => x.taskId === taskId && !x.resolved).length, 0);
});

test('resolveTask: with a kinds filter, only matching-kind entries for that card resolve', () => {
  const taskId = 't-clear-kind';
  errlog.capture('ci-failing', { taskId, text: 'red build' });
  errlog.capture('wrong-base', { taskId, text: 'bad base' });
  try {
    const n = errlog.resolveTask(taskId, ['ci-failing']);
    assert.equal(n, 1);
    const open = errlog.list().filter((x) => x.taskId === taskId && !x.resolved);
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, 'wrong-base');
  } finally {
    errlog.resolveTask(taskId);
  }
});

test('resolveKind: resolves only taskless entries of that kind, leaving card-attached entries of the same kind alone', () => {
  errlog.capture('limit', { text: 'board-wide cooldown' }); // no taskId
  errlog.capture('limit', { taskId: 't-limit-card', text: 'attached to a card, hypothetically' });
  try {
    const n = errlog.resolveKind('limit');
    assert.equal(n, 1);
    const stillOpen = errlog.list().filter((x) => x.kind === 'limit' && !x.resolved);
    assert.equal(stillOpen.length, 1);
    assert.equal(stillOpen[0].taskId, 't-limit-card');
  } finally {
    errlog.resolveTask('t-limit-card');
    errlog.resolveKind('limit');
  }
});

// --- list() / openCount() / forPrompt() --------------------------------------

test('list: open entries sort before resolved entries regardless of timestamps', () => {
  const resolvedOne = errlog.capture('run-failed', { taskId: 't-order-1', text: 'resolved one' });
  errlog.resolve(resolvedOne.id);
  errlog.capture('run-failed', { taskId: 't-order-2', text: 'still open' });
  try {
    const all = errlog.list();
    const openIdx = all.findIndex((e) => e.taskId === 't-order-2');
    const resolvedIdx = all.findIndex((e) => e.taskId === 't-order-1');
    assert.ok(openIdx < resolvedIdx);
  } finally {
    errlog.resolveTask('t-order-2');
    errlog.resolveTask('t-order-1');
  }
});

test('openCount: reflects only unresolved entries', () => {
  const before = errlog.openCount();
  const e = errlog.capture('run-failed', { taskId: 't-count', text: 'x' });
  assert.equal(errlog.openCount(), before + 1);
  errlog.resolve(e.id);
  assert.equal(errlog.openCount(), before);
});

test('forPrompt: returns only open entries, capped at max, in array order (oldest of the tail first)', () => {
  const taskId = 't-prompt';
  try {
    errlog.capture('run-failed', { taskId, text: 'prompt-a' });
    errlog.capture('run-failed', { taskId, text: 'prompt-b' });
    errlog.capture('run-failed', { taskId, text: 'prompt-c' });
    const mine = errlog.forPrompt(1000).filter((e) => e.taskId === taskId);
    assert.deepEqual(mine.map((e) => e.text), ['prompt-a', 'prompt-b', 'prompt-c']);
    const capped = errlog.forPrompt(1000).filter((e) => e.taskId === taskId).slice(-2);
    assert.deepEqual(capped.map((e) => e.text), ['prompt-b', 'prompt-c']);
  } finally {
    errlog.resolveTask(taskId);
  }
});

test('forPrompt: "seen" is only present once an entry has been captured more than once', () => {
  const taskId = 't-seen';
  try {
    errlog.capture('run-failed', { taskId, text: 'x' });
    let entry = errlog.forPrompt(1000).find((e) => e.taskId === taskId);
    assert.equal(entry.seen, undefined);
    errlog.capture('run-failed', { taskId, text: 'x' });
    entry = errlog.forPrompt(1000).find((e) => e.taskId === taskId);
    assert.equal(entry.seen, '2×');
  } finally {
    errlog.resolveTask(taskId);
  }
});

// --- prune lifecycle (only runs inside the debounced save()) ----------------

test('prune: entries resolved long enough ago (>14d) are dropped once save()/prune() next fires', async () => {
  const e = errlog.capture('run-failed', { taskId: 't-prune-old', text: 'ancient failure' });
  errlog.resolve(e.id);
  // Reach into the entry object returned by the public API (not the module's
  // private array) and backdate it past the 14-day cutoff.
  e.resolvedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  errlog.capture('run-failed', { taskId: 't-prune-trigger', text: 'trigger another save' }); // re-arms the debounce
  try {
    await settle();
    assert.equal(errlog.list().some((x) => x.id === e.id), false);
  } finally {
    errlog.resolveTask('t-prune-trigger');
  }
});

test('prune: a recently-resolved entry survives the same sweep', async () => {
  const e = errlog.capture('run-failed', { taskId: 't-prune-recent', text: 'recent failure' });
  errlog.resolve(e.id);
  try {
    await settle();
    assert.equal(errlog.list().some((x) => x.id === e.id), true);
  } finally {
    errlog.resolveTask('t-prune-recent');
  }
});

test('prune: overflow past MAX_ENTRIES (400) drops the oldest OPEN entries first', async () => {
  const ids = [];
  for (let i = 0; i < 405; i++) {
    const e = errlog.capture('run-failed', { taskId: `t-overflow-${i}`, text: `overflow entry ${i}` });
    ids.push(e.id);
  }
  try {
    await settle();
    const present = new Set(errlog.list().map((x) => x.id));
    // the first 5 captured (oldest) should have been dropped to stay at the 400 cap
    assert.equal(present.has(ids[0]), false);
    assert.equal(present.has(ids[4]), false);
    assert.equal(present.has(ids[404]), true); // most recent survives
  } finally {
    for (const i of Array.from({ length: 405 }, (_, n) => n)) errlog.resolveTask(`t-overflow-${i}`);
  }
});
