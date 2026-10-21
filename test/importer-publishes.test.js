const { test } = require('node:test');
const assert = require('node:assert/strict');
// A bad publishes line is logged to the error tracker, so use a temp data dir.
require('./helpers/temp-data-dir');

const { parseMarkdown, importMarkdown } = require('../lib/importer');
const store = require('../lib/store');
const errlog = require('../lib/errlog');

const forget = (created) => {
  store.state.tasks = store.state.tasks.filter((t) => !created.some((c) => c.id === t.id));
};

test('a publishes line becomes { name, path } and repeated lines accumulate', () => {
  const cards = parseMarkdown('## Writer\nworktree: true\npublishes: api-shape docs/api-shape.md\npublishes: codes docs\\errors.json\nbody');
  assert.deepEqual(cards[0].publishes, [
    { name: 'api-shape', path: 'docs/api-shape.md' },
    { name: 'codes', path: 'docs/errors.json' },
  ]);
  assert.equal(cards[0].prompt, 'body');
  assert.equal(cards.cwdWarnings, undefined);
});

test('a bad publishes name or traversal path warns with a reason, keeps reading header lines, and drops only that line', () => {
  for (const [line, why] of [
    ['publishes: Bad_Name docs/a.md', /name must match/],
    ['publishes: ok ../secrets.txt', /\.\./],
    ['publishes: ok a/../../b.txt', /\.\./],
    ['publishes: ok /etc/passwd', /relative/],
    ['publishes: ok C:\\Users\\x\\f.txt', /relative/],
    ['publishes: only-a-name', /expected/],
  ]) {
    const cards = parseMarkdown(`## Card\n${line}\nafter: Other\nbody`);
    assert.deepEqual(cards[0].publishes || [], [], line);
    assert.deepEqual(cards[0].depTitles, ['Other'], `${line}: a bad line must not end header parsing`);
    assert.equal(cards[0].prompt, 'body');
    assert.equal(cards.cwdWarnings.length, 1, line);
    assert.equal(cards.cwdWarnings[0].card, 'Card');
    assert.match(cards.cwdWarnings[0].reason, why, line);
  }
});

test('a bad publishes line lands in the error tracker naming the card; good lines still apply', () => {
  const created = importMarkdown('## Pub card\npublishes: good-one out/a.md\npublishes: bad ../x\nbody');
  try {
    assert.deepEqual(created[0].publishes, [{ name: 'good-one', path: 'out/a.md' }]);
    const hit = errlog.list().find((e) => e.kind === 'import' && e.taskId === created[0].id && /publishes/.test(e.text));
    assert.ok(hit, 'expected an import warning for the bad publishes line');
    assert.match(hit.text, /bad \.\.\/x/);
    assert.match(hit.text, /Pub card/);
  } finally {
    forget(created);
  }
});

test('cards without publishes get an empty list, and a frontmatter publishes is not a file-wide default', () => {
  const cards = parseMarkdown('---\npublishes: shared out/a.md\n---\n## One\nbody\n## Two\npublishes: own out/b.md\nbody');
  assert.equal(cards[0].publishes, undefined);
  assert.deepEqual(cards[1].publishes, [{ name: 'own', path: 'out/b.md' }]);
  const created = importMarkdown('## Plain\nbody');
  try {
    assert.deepEqual(created[0].publishes, []);
  } finally {
    forget(created);
  }
});
