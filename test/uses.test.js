// `uses:` — a card waiting on a contract: importer parsing, the readiness rule
// (server and client mirror), and API-style normalisation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Contracts and import warnings write to the data dir, so use a temp one.
require('./helpers/temp-data-dir');

const { parseMarkdown, importMarkdown } = require('../lib/importer');
const { ready, unmetUses, normalizeUses, parseUse, wouldCycle } = require('../lib/deps');
const contracts = require('../lib/contracts');
const store = require('../lib/store');
const errlog = require('../lib/errlog');

function withTasks(tasks, fn) {
  store.state.tasks.push(...tasks);
  try {
    fn();
  } finally {
    store.state.tasks.length = store.state.tasks.length - tasks.length;
  }
}

const forget = (created) => {
  store.state.tasks = store.state.tasks.filter((t) => !created.some((c) => c.id === t.id));
};

// --- importer ----------------------------------------------------------------

test('uses: parses both forms and repeated lines accumulate', () => {
  const cards = parseMarkdown('## Reader\nuses: api\nuses: schema@3\nafter: Writer\nbody');
  assert.deepEqual(cards[0].uses, [
    { name: 'api', version: null },
    { name: 'schema', version: 3 },
  ]);
  assert.deepEqual(cards[0].depTitles, ['Writer']);
  assert.equal(cards[0].prompt, 'body');
  assert.equal(cards.cwdWarnings, undefined);
});

test('a bad uses line warns with a reason and header parsing continues', () => {
  for (const [line, why] of [
    ['uses: Bad_Name', /name must match/],
    ['uses: api@0', /integer >= 1/],
    ['uses: api@two', /integer >= 1/],
    ['uses: api@1@2', /integer >= 1/],
    ['uses: two words', /expected/],
  ]) {
    const cards = parseMarkdown(`## Card\n${line}\nafter: Other\nbody`);
    assert.deepEqual(cards[0].uses || [], [], line);
    assert.deepEqual(cards[0].depTitles, ['Other'], `${line}: a bad line must not end header parsing`);
    assert.equal(cards[0].prompt, 'body', line);
    assert.equal(cards.cwdWarnings.length, 1, line);
    assert.equal(cards.cwdWarnings[0].key, 'uses', line);
    assert.match(cards.cwdWarnings[0].reason, why, line);
  }
});

test('an imported card stores uses (deduped), a bad line lands in the error tracker, and plain cards get []', () => {
  const created = importMarkdown('## Use card\nuses: api\nuses: api\nuses: api@2\nuses: Nope!\nbody\n## Plain\nbody');
  try {
    assert.deepEqual(created[0].uses, [{ name: 'api', version: null }, { name: 'api', version: 2 }]);
    assert.deepEqual(created[1].uses, []);
    const hit = errlog.list().find((e) => e.kind === 'import' && e.taskId === created[0].id && /uses "Nope!"/.test(e.text));
    assert.ok(hit, 'expected an import warning for the bad uses line');
    assert.match(hit.text, /Use card/);
  } finally {
    forget(created);
  }
});

test('a frontmatter uses is not a file-wide default', () => {
  const cards = parseMarkdown('---\nuses: shared\n---\n## One\nbody');
  assert.equal(cards[0].uses, undefined);
});

// --- readiness ---------------------------------------------------------------

test('unpinned uses waits until any version exists', () => {
  const card = { id: 'u1', uses: [{ name: 'ready-any', version: null }] };
  assert.equal(ready(card), false);
  assert.deepEqual(unmetUses(card), [{ name: 'ready-any', version: null }]);
  contracts.publish({ name: 'ready-any', content: 'v1' });
  assert.equal(ready(card), true);
  assert.deepEqual(unmetUses(card), []);
});

test('pinned uses waits for that exact version, and stays met once later versions land', () => {
  const card = { id: 'u2', uses: [{ name: 'ready-pin', version: 2 }] };
  contracts.publish({ name: 'ready-pin', content: 'one' });
  assert.equal(ready(card), false, 'v1 is not v2');
  contracts.publish({ name: 'ready-pin', content: 'two' });
  assert.equal(ready(card), true);
  contracts.publish({ name: 'ready-pin', content: 'three' });
  assert.equal(ready(card), true, 'v2 still exists after v3');
});

test('a contract that was never published keeps the card waiting', () => {
  assert.equal(ready({ id: 'u3', uses: [{ name: 'never-published', version: null }] }), false);
  assert.equal(ready({ id: 'u4', uses: [] }), true);
  assert.equal(ready({ id: 'u5' }), true);
});

test('mixed after: + uses: needs both', () => {
  contracts.publish({ name: 'ready-mixed', content: 'x' });
  const prereq = { id: 'mix-dep', status: 'running' };
  const card = { id: 'mix', deps: ['mix-dep'], uses: [{ name: 'ready-mixed', version: null }] };
  withTasks([prereq], () => {
    assert.equal(ready(card), false, 'dep not done, contract present');
    prereq.status = 'done';
    assert.equal(ready(card), true);
    assert.equal(ready({ ...card, uses: [{ name: 'ready-mixed', version: 9 }] }), false, 'dep done, pinned version missing');
  });
});

test('uses adds no task edges, so it cannot make a cycle', () => {
  const a = { id: 'cyc-a', deps: [], uses: [{ name: 'cyc-b', version: null }] };
  const b = { id: 'cyc-b', deps: [], uses: [{ name: 'cyc-a', version: null }] };
  withTasks([a, b], () => {
    assert.ok(!wouldCycle('cyc-a', ['cyc-b']));
  });
});

// --- API normalisation -------------------------------------------------------

test('normalizeUses accepts strings and objects, dedupes, and rejects bad entries', () => {
  assert.deepEqual(normalizeUses(['api', 'api@2', { name: 'api' }, { name: 'api', version: '2' }]), [
    { name: 'api', version: null },
    { name: 'api', version: 2 },
  ]);
  assert.deepEqual(normalizeUses([]), []);
  assert.throws(() => normalizeUses('api'), /array/);
  assert.throws(() => normalizeUses([{ name: 'Bad' }]), /name must match/);
  assert.throws(() => normalizeUses([{ name: 'api', version: 0 }]), /integer >= 1/);
  assert.throws(() => normalizeUses([42]), /each uses entry/);
  assert.throws(() => normalizeUses(Array.from({ length: 21 }, (_, i) => `c${i}`)), /limited to 20/);
  assert.deepEqual(parseUse(' api@12 '), { name: 'api', version: 12 });
});

// --- client mirror -----------------------------------------------------------

test('public/js/deps.js usesUnmet matches the server rule', async () => {
  const { usesUnmet, contractVersions, depPass } = await import('../public/js/deps.js');
  const list = [{ name: 'api', version: 2 }];
  const newest = contractVersions(list);
  const card = {
    id: 'c1',
    uses: [
      { name: 'api', version: null },
      { name: 'api', version: 2 },
      { name: 'api', version: 3 },
      { name: 'missing', version: null },
    ],
  };
  assert.deepEqual(usesUnmet(card, newest), [
    { name: 'api', version: 3 },
    { name: 'missing', version: null },
  ]);
  const server = unmetUses(card, new Map([['api', 2]]));
  assert.deepEqual(usesUnmet(card, newest), server);
  assert.deepEqual(usesUnmet({ id: 'c2' }, newest), []);

  const { state } = await import('../public/js/state.js');
  state.contracts = list;
  assert.deepEqual(depPass([card]).unmetUses(card).map((u) => u.name), ['api', 'missing']);
  state.contracts = [];
});
