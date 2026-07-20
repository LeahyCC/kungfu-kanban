const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sanitize, unmet, ready, dependentsOf, wouldCycle, prUnshipped } = require('../lib/deps');
const store = require('../lib/store');

function withTasks(tasks, fn) {
  store.state.tasks.push(...tasks);
  try {
    fn();
  } finally {
    store.state.tasks.length = store.state.tasks.length - tasks.length;
  }
}

// --- sanitize ------------------------------------------------------------

test('sanitize dedupes, drops self-references, and coerces to trimmed strings', () => {
  assert.deepEqual(sanitize(['a', 'b', 'a', 'self'], 'self'), ['a', 'b']);
  assert.deepEqual(sanitize([' a ', 'a'], 'x'), ['a']);
  assert.deepEqual(sanitize(['', null, undefined, 0], 'x'), []);
});

test('sanitize ignores non-array input', () => {
  assert.deepEqual(sanitize(null, 'x'), []);
  assert.deepEqual(sanitize(undefined, 'x'), []);
  assert.deepEqual(sanitize('not-an-array', 'x'), []);
});

// --- prUnshipped truth table -----------------------------------------------

test('prUnshipped: full truth table over status/openPr/prUrl/prMergedAt/prClosedNoted', () => {
  const cases = [
    // [dep, expected, label]
    [{ status: 'done', openPr: true, prUrl: 'https://x' }, true, 'done + open PR, no merge/close markers'],
    [{ status: 'done', openPr: true, prUrl: 'https://x', prMergedAt: '2026-01-01' }, false, 'merged'],
    [{ status: 'done', openPr: true, prUrl: 'https://x', prClosedNoted: true }, false, 'closed without merging'],
    [{ status: 'done', openPr: false }, false, 'no PR opened at all'],
    [{ status: 'done', openPr: true, prUrl: null }, false, 'openPr flag set but no prUrl yet'],
    [{ status: 'review', openPr: true, prUrl: 'https://x' }, false, 'not done yet'],
    [{ status: 'backlog' }, false, 'backlog card'],
  ];
  for (const [dep, expected, label] of cases) {
    // prUnshipped is a plain `&&` chain, not coerced — a falsy short-circuit
    // can surface as null/undefined/'' rather than the literal boolean false.
    assert.equal(!!prUnshipped(dep), expected, label);
  }
});

// --- unmet / ready -----------------------------------------------------------

test('unmet blocks a done card only while its PR is open and unmerged', () => {
  const shipped = { id: 'shipped', status: 'done', openPr: true, prUrl: 'https://x', prMergedAt: '2026-01-01T00:00:00Z' };
  const noPr = { id: 'no-pr', status: 'done' };
  const closed = { id: 'closed', status: 'done', openPr: true, prUrl: 'https://x', prClosedNoted: true };
  const openUnmerged = { id: 'open-unmerged', status: 'done', openPr: true, prUrl: 'https://x' };
  withTasks([shipped, noPr, closed, openUnmerged], () => {
    assert.deepEqual(unmet({ deps: ['shipped'] }), []);
    assert.deepEqual(unmet({ deps: ['no-pr'] }), []);
    assert.deepEqual(unmet({ deps: ['closed'] }), []);
    assert.deepEqual(unmet({ deps: ['open-unmerged'] }).map((d) => d.id), ['open-unmerged']);
  });
});

test('unmet blocks on any non-done dep status', () => {
  const backlog = { id: 'b', status: 'backlog' };
  const queued = { id: 'q', status: 'queued' };
  const running = { id: 'r', status: 'running' };
  const review = { id: 'rv', status: 'review' };
  withTasks([backlog, queued, running, review], () => {
    const out = unmet({ deps: ['b', 'q', 'r', 'rv'] }).map((d) => d.id);
    assert.deepEqual(out.sort(), ['b', 'q', 'r', 'rv']);
  });
});

test('unmet treats an unresolvable (deleted) dep id as satisfied', () => {
  assert.deepEqual(unmet({ deps: ['does-not-exist'] }), []);
});

test('unmet returns [] for a task with no deps field', () => {
  assert.deepEqual(unmet({}), []);
});

test('ready() mirrors unmet().length === 0', () => {
  const done = { id: 'd', status: 'done' };
  const blocked = { id: 'bl', status: 'backlog' };
  withTasks([done, blocked], () => {
    assert.equal(ready({ deps: ['d'] }), true);
    assert.equal(ready({ deps: ['bl'] }), false);
    assert.equal(ready({ deps: [] }), true);
  });
});

// --- dependentsOf --------------------------------------------------------

test('dependentsOf finds only queued/backlog cards depending on the given id, ignoring other statuses', () => {
  const q = { id: 'q1', deps: ['x'], status: 'queued' };
  const b = { id: 'b1', deps: ['x'], status: 'backlog' };
  const running = { id: 'r1', deps: ['x'], status: 'running' };
  const done = { id: 'd1', deps: ['x'], status: 'done' };
  const unrelated = { id: 'u1', deps: ['y'], status: 'queued' };
  withTasks([q, b, running, done, unrelated], () => {
    const out = dependentsOf('x').map((t) => t.id).sort();
    assert.deepEqual(out, ['b1', 'q1']);
  });
});

// --- wouldCycle --------------------------------------------------------------

test('wouldCycle detects a direct cycle back to the card itself', () => {
  const a = { id: 'a', deps: [] };
  const b = { id: 'b', deps: ['a'] };
  withTasks([a, b], () => {
    assert.ok(wouldCycle('a', ['b'])); // a -> b -> a
    assert.ok(!wouldCycle('a', []));
  });
});

test('wouldCycle detects a transitive (multi-hop) cycle', () => {
  const a = { id: 'a', deps: [] };
  const b = { id: 'b', deps: ['a'] };
  const c = { id: 'c', deps: ['b'] };
  withTasks([a, b, c], () => {
    assert.ok(wouldCycle('a', ['c'])); // a -> c -> b -> a
  });
});

test('wouldCycle returns false for an unrelated/disjoint graph', () => {
  const a = { id: 'a', deps: [] };
  const b = { id: 'b', deps: [] };
  const c = { id: 'c', deps: ['b'] };
  withTasks([a, b, c], () => {
    assert.ok(!wouldCycle('a', ['c']));
  });
});

test('wouldCycle does not loop forever on an already-cyclic graph unrelated to the proposed id', () => {
  const x = { id: 'x', deps: ['y'] };
  const y = { id: 'y', deps: ['x'] };
  const z = { id: 'z', deps: [] };
  withTasks([x, y, z], () => {
    assert.ok(!wouldCycle('z', ['x']));
  });
});

test('wouldCycle handles a proposed dep id that does not resolve to any task', () => {
  assert.ok(!wouldCycle('a', ['ghost']));
});
