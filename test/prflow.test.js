const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// KFK_DATA_DIR must be set before requiring lib/store: prFooterEnabled reads
// store.state.settings, and a checkout whose data/settings.json has
// prFooter: false would otherwise turn the footer off for every test here.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-prflow-data-'));
process.env.KFK_DATA_DIR = DATA_DIR;

const { prBody, parseDuplicatePrUrl, contributingForbidsAttribution, prFooterEnabled, matchesTemplate, headingsOf } = require('../lib/prflow');
const store = require('../lib/store');

// A scratch "repo" directory per test that wants CONTRIBUTING.md / a PR
// template on disk — prBody reads task.cwd directly, no mocking hook.
const scratchDirs = [];
function scratchRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-prflow-'));
  scratchDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
after(() => {
  for (const d of [...scratchDirs, DATA_DIR]) fs.rmSync(d, { recursive: true, force: true });
});

// "Fixes #N" is the load-bearing line: it is what auto-closes an imported
// GitHub issue when the PR merges. Lock it against refactors.
test('prBody: imported-issue cards lead with the closing keyword', () => {
  const body = prBody({ issueNumber: 42, prompt: 'do the thing' });
  assert.match(body, /^Fixes #42\n/);
});

test('prBody: no issueNumber → no closing keyword', () => {
  const body = prBody({ prompt: 'do the thing' });
  assert.ok(!body.includes('Fixes #'));
});

test('prBody: footer credits the project in both shapes', () => {
  assert.match(prBody({ issueNumber: 7 }), /🥋 Opened by/);
  assert.match(prBody({}), /🥋 Opened by/);
});

test('prBody: prompt is truncated at 1500 chars', () => {
  const body = prBody({ prompt: 'x'.repeat(2000) });
  assert.ok(body.includes('x'.repeat(1500)));
  assert.ok(!body.includes('x'.repeat(1501)));
});

// --- prefer the run's final report when it fills in the repo's own PR
// template (2026-09-10 batch addendum: the raw task prompt — instructions TO
// the agent — was used as the body even when the agent already wrote a
// proper templated summary as its final message) ----------------------------

test('headingsOf: extracts "## Heading" lines, case/whitespace-insensitively', () => {
  assert.deepEqual(headingsOf('## Summary\nsome text\n### Test Plan  \n'), ['summary', 'test plan']);
  assert.deepEqual(headingsOf(''), []);
  assert.deepEqual(headingsOf(null), []);
});

test('matchesTemplate: true when a majority of the template\'s headings appear in the text', () => {
  const template = '## Summary\n\n## Test plan\n';
  assert.ok(matchesTemplate('## Summary\nDid the thing.\n\n## Test plan\n- ran it', template));
  assert.ok(matchesTemplate('## summary\ncase-insensitive match', '## Summary\n')); // single-heading template: one hit already clears ceil(1/2)
  assert.ok(!matchesTemplate('just some prose, no headings at all', template));
});

test('matchesTemplate: false when there is no template to match against', () => {
  assert.ok(!matchesTemplate('## Summary\nhi', null));
  assert.ok(!matchesTemplate('## Summary\nhi', ''));
});

test('prBody: uses the run\'s final report as the body when it fills in the repo\'s PR template', () => {
  const cwd = scratchRepo({
    '.github/PULL_REQUEST_TEMPLATE.md': '## Summary\n<bullets>\n\n## Test plan\n<checklist>\n',
  });
  const resultText = '## Summary\n- Fixed the thing\n\n## Test plan\n- [x] npm test';
  const body = prBody({ cwd, prompt: 'do the thing (instructions to the agent, not a summary)', resultText });
  assert.match(body, /Fixed the thing/);
  assert.ok(!body.includes('instructions to the agent'), 'the raw prompt is dropped once the report fills the template');
});

test('prBody: falls back to the raw prompt when the final report does NOT fill the repo\'s template', () => {
  const cwd = scratchRepo({
    '.github/PULL_REQUEST_TEMPLATE.md': '## Summary\n\n## Test plan\n',
  });
  const body = prBody({ cwd, prompt: 'do the thing', resultText: 'Done! Everything works now.' });
  assert.match(body, /## Task\ndo the thing/);
});

test('prBody: falls back to the raw prompt when the repo has no PR template at all', () => {
  const cwd = scratchRepo({}); // no .github/PULL_REQUEST_TEMPLATE.md
  const body = prBody({ cwd, prompt: 'do the thing', resultText: '## Summary\nDid it\n\n## Test plan\nran it' });
  assert.match(body, /## Task\ndo the thing/);
});

// --- drop the attribution footer when the repo's own CONTRIBUTING.md
// forbids it, or when the board-wide setting turns it off ------------------

test('contributingForbidsAttribution: detects common "no AI/tool attribution" phrasings in CONTRIBUTING.md', () => {
  const forbidding = scratchRepo({ 'CONTRIBUTING.md': 'Please write clear commits.\nNo AI attribution footers in commit messages or PR bodies.\n' });
  assert.ok(contributingForbidsAttribution(forbidding));

  const alsoForbidding = scratchRepo({ 'CONTRIBUTING.md': 'This project forbids tool attribution in PR descriptions.' });
  assert.ok(contributingForbidsAttribution(alsoForbidding));

  const silent = scratchRepo({ 'CONTRIBUTING.md': 'Please write clear commit messages and add tests.' });
  assert.ok(!contributingForbidsAttribution(silent));
});

test('contributingForbidsAttribution: no CONTRIBUTING.md, or no cwd at all, is not a match', () => {
  const noFile = scratchRepo({});
  assert.ok(!contributingForbidsAttribution(noFile));
  assert.ok(!contributingForbidsAttribution(undefined));
});

test('prFooterEnabled: false when the repo\'s CONTRIBUTING.md forbids attribution', () => {
  const cwd = scratchRepo({ 'CONTRIBUTING.md': 'No AI attribution footers, ever.' });
  assert.equal(prFooterEnabled(cwd), false);
});

test('prBody: drops the footer for a repo whose CONTRIBUTING.md forbids tool attribution', () => {
  const cwd = scratchRepo({ 'CONTRIBUTING.md': 'No AI attribution footers, ever.' });
  const body = prBody({ cwd, prompt: 'do the thing' });
  assert.ok(!body.includes('Opened by'));
});

test('prFooterEnabled / prBody: the board-wide prFooter=false setting drops the footer everywhere, even a repo with no opinion', () => {
  const before = store.state.settings.prFooter;
  store.state.settings.prFooter = false;
  try {
    const cwd = scratchRepo({});
    assert.equal(prFooterEnabled(cwd), false);
    assert.ok(!prBody({ cwd, prompt: 'do the thing' }).includes('Opened by'));
  } finally {
    store.state.settings.prFooter = before;
  }
});

test('prFooterEnabled: true by default (no setting, no CONTRIBUTING.md opinion)', () => {
  const cwd = scratchRepo({});
  assert.equal(prFooterEnabled(cwd), true);
});

// A card's own agent opening its own PR races the board's PR flow: gh
// refuses the duplicate but hands back the existing URL in the same
// message. That URL must be recoverable instead of leaving the card
// stranded with no prUrl (bouldi PRs #935-#937, 2026-07-28).
test('parseDuplicatePrUrl: extracts the URL from gh\'s duplicate-PR error', () => {
  const err = 'a pull request for branch "kanban-abc123" into branch "main" already exists: https://github.com/LeahyCC/bouldi/pull/935';
  assert.equal(parseDuplicatePrUrl(err), 'https://github.com/LeahyCC/bouldi/pull/935');
});

test('parseDuplicatePrUrl: other gh pr create failures return null', () => {
  assert.equal(parseDuplicatePrUrl('pull request create failed: GraphQL: Head sha can\'t be blank'), null);
  assert.equal(parseDuplicatePrUrl('HTTP 401: Bad credentials'), null);
});
