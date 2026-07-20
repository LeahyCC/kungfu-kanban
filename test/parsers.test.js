const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseMarkdown, labelFromFilename } = require('../lib/importer');
const { detect, parseReset } = require('../lib/cooldown');
const { summarizeChecks } = require('../lib/prwatch');
const { newer } = require('../lib/version');
const { sanitize, wouldCycle } = require('../lib/deps');
const { fallbackFor } = require('../lib/models');

// --- importer.parseMarkdown -------------------------------------------------

test('parseMarkdown: fenced code blocks do not split into cards', () => {
  const cards = parseMarkdown('## Real heading\n```\n## not a heading\n```\nbody text');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Real heading');
  assert.match(cards[0].prompt, /not a heading/);
});

test('parseMarkdown: CRLF line endings are normalized', () => {
  const cards = parseMarkdown('## Title\r\nmodel: sonnet\r\nDo the thing.\r\n');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].model, 'sonnet');
  assert.equal(cards[0].prompt, 'Do the thing.');
});

test('parseMarkdown: prose field-shaped lines in the prompt are not mistaken for fields', () => {
  const cards = parseMarkdown('## Title\nWrite documentation: explain the API surface clearly.');
  assert.equal(cards.length, 1);
  assert.match(cards[0].prompt, /Write documentation: explain/);
});

test('parseMarkdown: checklist mode picks up only unchecked items', () => {
  const cards = parseMarkdown('- [ ] first task\n- [x] done already\n- [ ] second task');
  assert.deepEqual(cards.map((c) => c.title), ['first task', 'second task']);
});

test('parseMarkdown: frontmatter defaults apply to every section card', () => {
  const cards = parseMarkdown('---\nmodel: opus\n---\n## One\nbody\n## Two\nbody');
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.model === 'opus'));
});

test('parseMarkdown: fenced "### Acceptance" heading inside a card body is not treated as the acceptance section', () => {
  const cards = parseMarkdown('## Title\n```\n### Acceptance\nnot real\n```\nprompt text');
  assert.equal(cards[0].acceptanceCriteria, undefined);
  assert.match(cards[0].prompt, /not real/);
});

test('parseMarkdown: group/batch fields set the group, per-card overrides the frontmatter default', () => {
  const cards = parseMarkdown('---\ngroup: Batch A\n---\n## One\nbody\n## Two\nbatch: Batch B\nbody');
  assert.equal(cards[0].group, 'Batch A');
  assert.equal(cards[1].group, 'Batch B');
});

test('parseMarkdown: defaultGroup fills in only when no explicit group was set', () => {
  const withDefault = parseMarkdown('## One\nbody', 'Inbox label');
  assert.equal(withDefault[0].group, 'Inbox label');
  const explicit = parseMarkdown('---\ngroup: Explicit\n---\n## One\nbody', 'Inbox label');
  assert.equal(explicit[0].group, 'Explicit');
});

test('labelFromFilename strips extension and a trailing date-time stamp', () => {
  assert.equal(labelFromFilename('app-quality-audit-20260719-2057.md'), 'App quality audit');
  assert.equal(labelFromFilename('quick-fixes.md'), 'Quick fixes');
});

// --- cooldown.detect / parseReset -------------------------------------------

test('cooldown.detect matches known limit phrasings', () => {
  assert.ok(detect("You've hit your session limit · resets 11:30pm"));
  assert.ok(detect('usage limit reached'));
  assert.ok(detect('rate limit exceeded, too many requests'));
  assert.ok(!detect('some unrelated network error'));
});

test('cooldown.parseReset reads an embedded unix epoch', () => {
  const t = Date.now() + 3600_000;
  const epoch = Math.floor(t / 1000);
  const parsed = parseReset(`limit reached, resets at ${epoch}`);
  assert.equal(parsed, epoch * 1000);
});

test('cooldown.parseReset reads "resets 3pm" wall-clock phrasing', () => {
  const parsed = parseReset('resets 3pm');
  const d = new Date(parsed);
  assert.equal(d.getHours(), 15);
  assert.equal(d.getMinutes(), 0);
});

test('cooldown.parseReset falls back to an hour out when nothing matches', () => {
  const before = Date.now();
  const parsed = parseReset('no timing info here');
  assert.ok(parsed >= before + 59 * 60_000 && parsed <= before + 61 * 60_000);
});

// --- prwatch.summarizeChecks -------------------------------------------------

test('summarizeChecks rolls up mixed CheckRun and StatusContext entries', () => {
  const out = summarizeChecks([
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'ci/old-fail', state: 'ERROR' },
    { __typename: 'StatusContext', context: 'ci/pending', state: 'PENDING' },
  ]);
  assert.equal(out.passing, 2);
  assert.equal(out.failing, 2);
  assert.equal(out.pending, 2);
  assert.deepEqual(out.failed, ['test', 'ci/old-fail']);
});

test('summarizeChecks handles an empty/missing rollup', () => {
  assert.deepEqual(summarizeChecks(null), { passing: 0, failing: 0, pending: 0, failed: [] });
});

// --- version.newer -----------------------------------------------------------

test('newer compares numeric semver correctly', () => {
  assert.ok(newer('0.13.0', '0.12.9'));
  assert.ok(newer('1.0.0', '0.99.99'));
  assert.ok(!newer('0.12.0', '0.12.0'));
  assert.ok(!newer('0.12.0', '0.13.0'));
});

test('newer treats missing input as not newer', () => {
  assert.ok(!newer(null, '0.1.0'));
  assert.ok(!newer('0.1.0', undefined));
});

// --- deps.sanitize / wouldCycle ----------------------------------------------

test('sanitize dedupes and drops self-references', () => {
  assert.deepEqual(sanitize(['a', 'b', 'a', 'self'], 'self'), ['a', 'b']);
});

test('sanitize ignores non-array input', () => {
  assert.deepEqual(sanitize(null, 'x'), []);
});

test('wouldCycle detects a direct cycle back to the card itself', () => {
  const store = require('../lib/store');
  const a = { id: 'a', deps: [] };
  const b = { id: 'b', deps: ['a'] };
  store.state.tasks.push(a, b);
  try {
    assert.ok(wouldCycle('a', ['b'])); // a -> b -> a
    assert.ok(!wouldCycle('a', []));
  } finally {
    store.state.tasks.length = store.state.tasks.length - 2;
  }
});

// --- models.fallbackFor --------------------------------------------------------

test('fallbackFor blocks the model matched as a substring of the full modelUsed id', () => {
  const task = { model: 'sonnet', modelUsed: 'claude-3-5-sonnet-20241022' };
  const next = fallbackFor(task, 'sonnet capacity limit reached');
  assert.equal(next, 'haiku');
});
