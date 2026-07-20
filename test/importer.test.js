const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseMarkdown, labelFromFilename, resolveDep } = require('../lib/importer');
const store = require('../lib/store');

// --- frontmatter defaults + per-card overrides, one key/alias at a time -----

const FIELD_CASES = [
  { name: 'cwd', fm: 'cwd: /repo', card: 'cwd: /other', assertDefault: (c) => assert.equal(c.cwd, '/repo'), assertOverride: (c) => assert.equal(c.cwd, '/other') },
  { name: 'dir alias', fm: 'dir: ~/repo', card: null, assertDefault: (c) => assert.equal(c.cwd, '~/repo') },
  { name: 'directory alias', fm: 'directory: ./repo', card: null, assertDefault: (c) => assert.equal(c.cwd, './repo') },
  { name: 'repo alias', fm: 'repo: /r', card: null, assertDefault: (c) => assert.equal(c.cwd, '/r') },
  { name: 'model', fm: 'model: opus', card: 'model: haiku', assertDefault: (c) => assert.equal(c.model, 'opus'), assertOverride: (c) => assert.equal(c.model, 'haiku') },
  { name: 'effort', fm: 'effort: high', card: 'effort: low', assertDefault: (c) => assert.equal(c.effort, 'high'), assertOverride: (c) => assert.equal(c.effort, 'low') },
  { name: 'permissions', fm: 'permissions: plan', card: 'permissions: auto', assertDefault: (c) => assert.equal(c.permissionMode, 'plan'), assertOverride: (c) => assert.equal(c.permissionMode, 'auto') },
  { name: 'permissionMode alias', fm: 'permissionMode: dontAsk', card: null, assertDefault: (c) => assert.equal(c.permissionMode, 'dontAsk') },
  { name: 'perms alias', fm: 'perms: bypassPermissions', card: null, assertDefault: (c) => assert.equal(c.permissionMode, 'bypassPermissions') },
  { name: 'priority', fm: 'priority: 2', card: 'priority: 0', assertDefault: (c) => assert.equal(c.priority, 2), assertOverride: (c) => assert.equal(c.priority, 0) },
  { name: 'worktree', fm: 'worktree: true', card: 'worktree: false', assertDefault: (c) => assert.equal(c.worktree, true), assertOverride: (c) => assert.equal(c.worktree, false) },
  { name: 'openPr', fm: 'openPr: true', card: 'openPr: no', assertDefault: (c) => assert.equal(c.openPr, true), assertOverride: (c) => assert.equal(c.openPr, false) },
  { name: 'pr alias', fm: 'pr: yes', card: null, assertDefault: (c) => assert.equal(c.openPr, true) },
  { name: 'agent', fm: 'agent: explore', card: 'agent: general-purpose', assertDefault: (c) => assert.equal(c.agent, 'explore'), assertOverride: (c) => assert.equal(c.agent, 'general-purpose') },
  { name: 'skills', fm: 'skills: a, b', card: 'skills: c', assertDefault: (c) => assert.deepEqual(c.skills, ['a', 'b']), assertOverride: (c) => assert.deepEqual(c.skills, ['c']) },
  { name: 'acceptance', fm: null, card: null, skip: true }, // covered separately (### Acceptance section semantics)
  { name: 'group', fm: 'group: Batch A', card: 'group: Batch B', assertDefault: (c) => assert.equal(c.group, 'Batch A'), assertOverride: (c) => assert.equal(c.group, 'Batch B') },
  { name: 'batch alias', fm: 'batch: X', card: null, assertDefault: (c) => assert.equal(c.group, 'X') },
  { name: 'issue', fm: 'issue: 42', card: 'issue: #7', assertDefault: (c) => assert.equal(c.issueNumber, 42), assertOverride: (c) => assert.equal(c.issueNumber, 7) },
  { name: 'issueNumber alias', fm: 'issueNumber: 3', card: null, assertDefault: (c) => assert.equal(c.issueNumber, 3) },
  { name: 'base', fm: 'base: staging', card: 'base: main', assertDefault: (c) => assert.equal(c.prBaseBranch, 'staging'), assertOverride: (c) => assert.equal(c.prBaseBranch, 'main') },
  { name: 'prBase alias', fm: 'prBase: dev', card: null, assertDefault: (c) => assert.equal(c.prBaseBranch, 'dev') },
  { name: 'baseBranch alias', fm: 'baseBranch: rel', card: null, assertDefault: (c) => assert.equal(c.prBaseBranch, 'rel') },
  { name: 'queue', fm: 'queue: true', card: 'queue: false', assertDefault: (c) => assert.equal(c.queue, true), assertOverride: (c) => assert.equal(c.queue, false) },
  { name: 'autoqueue alias', fm: 'autoqueue: yes', card: null, assertDefault: (c) => assert.equal(c.queue, true) },
];

for (const fc of FIELD_CASES) {
  if (fc.skip) continue;
  test(`importer field "${fc.name}": frontmatter default applies to a card with no override`, () => {
    const cards = parseMarkdown(`---\n${fc.fm}\n---\n## One\nbody`);
    fc.assertDefault(cards[0]);
  });
  if (fc.card) {
    test(`importer field "${fc.name}": per-card line overrides the frontmatter default`, () => {
      const cards = parseMarkdown(`---\n${fc.fm}\n---\n## One\n${fc.card}\nbody`);
      fc.assertOverride(cards[0]);
    });
  }
}

test('importer field "after"/"deps"/"dependson"/"needs" all set depTitles, repeated lines concat', () => {
  const aliases = ['after', 'deps', 'dependson', 'needs'];
  for (const a of aliases) {
    const cards = parseMarkdown(`## Two\n${a}: One\nbody`);
    assert.deepEqual(cards[0].depTitles, ['One'], a);
  }
  const cards = parseMarkdown('## Two\nafter: One\nafter: Zero\nbody');
  assert.deepEqual(cards[0].depTitles, ['One', 'Zero']);
});

// --- invalid field VALUES stop field-parsing and fall through to prompt -----

test('importer: an unrecognized value on a recognized-key line ends field parsing (line becomes prompt text)', () => {
  const cases = [
    'model: instagram',
    'effort: extreme',
    'permissions: sudo',
    'priority: not-a-number',
    'issue: -3',
    'issue: abc',
    'base: has spaces',
    'cwd: relative/no-prefix',
    'acceptance:', // empty value is falsy for this field
    'after:', // empty value is falsy for this field
  ];
  for (const line of cases) {
    const cards = parseMarkdown(`## Title\n${line}\nrest of body`);
    assert.match(cards[0].prompt, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), line);
  }
});

test('importer: worktree/openPr/sequential/queue accept any value and never break parsing (false on non-truthy)', () => {
  const cards = parseMarkdown('## Title\nworktree: banana\nopenPr: nah\nqueue: nope\nActual prompt line.', undefined);
  assert.equal(cards[0].worktree, false);
  assert.equal(cards[0].openPr, false);
  assert.equal(cards[0].queue, false);
  assert.match(cards[0].prompt, /Actual prompt line/);
});

test('importer: priority clamps to [0,3]', () => {
  assert.equal(parseMarkdown('## T\npriority: 99\nx')[0].priority, 3);
  assert.equal(parseMarkdown('## T\npriority: -5\nx')[0].priority, 0);
  assert.equal(parseMarkdown('## T\npriority: 0\nx')[0].priority, 0);
});

test('importer: field key normalization strips spaces/dashes/underscores', () => {
  assert.equal(parseMarkdown('## T\npermission-mode: plan\nx')[0].permissionMode, 'plan');
  assert.equal(parseMarkdown('## T\nopen_pr: true\nx')[0].openPr, true);
});

// --- checklist mode ----------------------------------------------------------

test('parseMarkdown: checklist mode picks up only unchecked items', () => {
  const cards = parseMarkdown('- [ ] first task\n- [x] done already\n- [ ] second task');
  assert.deepEqual(cards.map((c) => c.title), ['first task', 'second task']);
});

test('parseMarkdown: checklist mode accepts both - and * bullets and uppercase X as checked', () => {
  const cards = parseMarkdown('* [ ] star bullet\n- [X] uppercase done\n- [ ] dash bullet');
  assert.deepEqual(cards.map((c) => c.title), ['star bullet', 'dash bullet']);
});

test('parseMarkdown: zero cards from prose-only text or an all-checked checklist', () => {
  assert.deepEqual(parseMarkdown('Just some prose.\nNo headings, no checklist.'), []);
  assert.deepEqual(parseMarkdown('- [x] all done\n- [X] also done'), []);
  assert.deepEqual(parseMarkdown(''), []);
});

// --- CRLF, fenced-heading immunity, prose field-line rejection --------------

test('parseMarkdown: CRLF line endings are normalized', () => {
  const cards = parseMarkdown('## Title\r\nmodel: sonnet\r\nDo the thing.\r\n');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].model, 'sonnet');
  assert.equal(cards[0].prompt, 'Do the thing.');
});

test('parseMarkdown: fenced code blocks do not split into cards', () => {
  const cards = parseMarkdown('## Real heading\n```\n## not a heading\n```\nbody text');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Real heading');
  assert.match(cards[0].prompt, /not a heading/);
});

test('parseMarkdown: an unclosed fence still suppresses heading-splitting for the rest of the file', () => {
  const cards = parseMarkdown('## Real\n```\n## inside fence one\n## inside fence two\nno closing fence');
  assert.equal(cards.length, 1);
});

test('parseMarkdown: prose field-shaped lines are not mistaken for fields (cwd/base shapes)', () => {
  const cwdShaped = parseMarkdown('## Title\nWrite documentation: explain the API surface clearly.');
  assert.equal(cwdShaped.length, 1);
  assert.match(cwdShaped[0].prompt, /Write documentation: explain/);

  const notACwd = parseMarkdown('## Title\ncwd: talk to the backend team about this\nmore prompt');
  assert.match(notACwd[0].prompt, /cwd: talk to the backend team/);

  const notABase = parseMarkdown('## Title\nbase: whatever CI decides is fine\nmore prompt');
  assert.match(notABase[0].prompt, /base: whatever CI decides/);
});

// --- acceptance splitting, fence-aware ---------------------------------------

test('parseMarkdown: "### Acceptance" section becomes acceptanceCriteria and leaves the prompt', () => {
  const cards = parseMarkdown('## Title\nDo the work.\n### Acceptance\n- criterion one\n- criterion two');
  assert.equal(cards[0].prompt, 'Do the work.');
  assert.match(cards[0].acceptanceCriteria, /criterion one/);
  assert.match(cards[0].acceptanceCriteria, /criterion two/);
});

test('parseMarkdown: "### Acceptance Criteria" heading variant is also recognized', () => {
  const cards = parseMarkdown('## Title\nDo it.\n### Acceptance Criteria\n- x');
  assert.match(cards[0].acceptanceCriteria, /- x/);
});

test('parseMarkdown: an empty "### Acceptance" section leaves acceptanceCriteria unset', () => {
  const cards = parseMarkdown('## Title\nDo it.\n### Acceptance\n');
  assert.equal(cards[0].acceptanceCriteria, undefined);
});

test('parseMarkdown: fenced "### Acceptance" heading inside a card body is not treated as the acceptance section', () => {
  const cards = parseMarkdown('## Title\n```\n### Acceptance\nnot real\n```\nprompt text');
  assert.equal(cards[0].acceptanceCriteria, undefined);
  assert.match(cards[0].prompt, /not real/);
});

// --- group / defaultGroup / queue flags --------------------------------------

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

test('parseMarkdown: frontmatter "queue" (and alias "autoqueue") sets a file-wide default', () => {
  const cards = parseMarkdown('---\nqueue: true\n---\n## One\nbody\n## Two\nbody');
  assert.ok(cards.every((c) => c.queue === true));
  const aliased = parseMarkdown('---\nautoqueue: yes\n---\n## One\nbody');
  assert.equal(aliased[0].queue, true);
});

// --- sequential / after ordering (afterPrev derivation) ----------------------

test('parseMarkdown: "after: previous" chains a card to the one before it, dropping the keyword from depTitles', () => {
  const cards = parseMarkdown('## One\nbody\n## Two\nafter: previous\nbody');
  assert.equal(cards[0].afterPrev, undefined);
  assert.equal(cards[1].afterPrev, true);
  assert.deepEqual(cards[1].depTitles, []);
});

test('parseMarkdown: frontmatter "sequential: true" chains every card lacking its own explicit deps', () => {
  const cards = parseMarkdown('---\nsequential: true\n---\n## One\nbody\n## Two\nbody\n## Three\nbody');
  assert.equal(cards[0].afterPrev, undefined); // first card: no "previous" to chain to
  assert.equal(cards[1].afterPrev, true);
  assert.equal(cards[2].afterPrev, true);
});

test('parseMarkdown: sequential does not override a card that already declares an explicit dependency', () => {
  const cards = parseMarkdown('---\nsequential: true\n---\n## One\nbody\n## Two\nafter: Some Other Title\nbody');
  assert.equal(cards[1].afterPrev, undefined);
  assert.deepEqual(cards[1].depTitles, ['Some Other Title']);
});

test('parseMarkdown: mixing "after: previous" with an explicit dep still chains to previous AND keeps the explicit dep', () => {
  const cards = parseMarkdown('## One\nbody\n## Two\nafter: previous\nafter: Explicit Title\nbody');
  assert.equal(cards[1].afterPrev, true);
  assert.deepEqual(cards[1].depTitles, ['Explicit Title']);
});

test('parseMarkdown: a per-card "sequential" field is discarded in section mode (file-wide only)', () => {
  const cards = parseMarkdown('## One\nsequential: true\nbody');
  assert.equal(cards[0].sequential, undefined);
});

// --- labelFromFilename --------------------------------------------------------

test('labelFromFilename strips extension and a trailing date-time stamp', () => {
  assert.equal(labelFromFilename('app-quality-audit-20260719-2057.md'), 'App quality audit');
  assert.equal(labelFromFilename('quick-fixes.md'), 'Quick fixes');
});

test('labelFromFilename is case-insensitive on the .md extension', () => {
  assert.equal(labelFromFilename('quick-fixes.MD'), 'Quick fixes');
});

test('labelFromFilename only strips a stamp shaped exactly -YYYYMMDD-HHMM', () => {
  assert.equal(labelFromFilename('report-202607.md'), 'Report 202607');
  assert.equal(labelFromFilename('report-2026-07-19-2057.md'), 'Report 2026 07 19 2057');
});

test('labelFromFilename capitalizes only the first character', () => {
  assert.equal(labelFromFilename('fix ACME bug.md'), 'Fix ACME bug');
});

// --- resolveDep ---------------------------------------------------------------

test('resolveDep: ordinal reference (#N or N) picks the Nth card in the batch', () => {
  const batch = [{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }];
  assert.equal(resolveDep('#2', batch).id, 'b');
  assert.equal(resolveDep('1', batch).id, 'a');
  assert.equal(resolveDep('#9', batch), null);
});

test('resolveDep: matches an earlier card in the same batch by title, case-insensitively', () => {
  const batch = [{ id: 'a', title: 'Set Up Schema' }];
  assert.equal(resolveDep('set up schema', batch).id, 'a');
});

test('resolveDep: falls back to a board card by title when not found in-batch', () => {
  const t = { id: 'board-1', title: 'Existing Board Card', deps: [] };
  store.state.tasks.push(t);
  try {
    assert.equal(resolveDep('Existing Board Card', []).id, 'board-1');
  } finally {
    store.state.tasks.pop();
  }
});

test('resolveDep: matches a board card by exact id or an 8+ char id prefix', () => {
  const t = { id: 'abcdef12-3456-7890-abcd-ef1234567890', title: 'X', deps: [] };
  store.state.tasks.push(t);
  try {
    assert.equal(resolveDep(t.id, []).id, t.id);
    assert.equal(resolveDep('abcdef12', []).id, t.id);
    assert.equal(resolveDep('abcdef1', []), null); // 7 chars — below the 8+ prefix floor
  } finally {
    store.state.tasks.pop();
  }
});

test('resolveDep: an unresolvable reference returns null', () => {
  assert.equal(resolveDep('nothing matches this', []), null);
});
