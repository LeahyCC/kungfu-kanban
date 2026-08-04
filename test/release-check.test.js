const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sectionBody, priorReleaseTag, mergedPRNumbers, auditRelease } = require('../scripts/check-release');

const CL = `# Changelog

## [Unreleased]

## [1.2.0] — 2026-07-21
### Added
- Thing one (#90)
- Thing two (#91)

## [1.1.0] — 2026-07-20
### Added
- Old thing (#83)
`;

test('sectionBody extracts only the requested version section', () => {
  assert.match(sectionBody(CL, '1.2.0'), /Thing one/);
  assert.doesNotMatch(sectionBody(CL, '1.2.0'), /Old thing/);
  assert.equal(sectionBody(CL, '9.9.9'), null);
});

test('priorReleaseTag picks the highest tag strictly below the version', () => {
  assert.equal(priorReleaseTag(['v1.0.0', 'v1.1.0', 'v1.0.1'], '1.2.0'), 'v1.1.0');
  assert.equal(priorReleaseTag(['v1.1.0'], '1.1.0'), null); // none strictly below
  assert.equal(priorReleaseTag([], '1.0.0'), null);
});

test('mergedPRNumbers extracts PRs and drops dependabot branches', () => {
  const log = [
    'Merge pull request #90 from LeahyCC/feat',
    'Merge pull request #91 from LeahyCC/dependabot/npm_and_yarn/express-5',
    'Merge pull request #92 from LeahyCC/fix',
  ].join('\n');
  assert.deepEqual(mergedPRNumbers(log), ['90', '92']);
});

// The release's own PR wrote the section it is being audited against, and its
// merge commit lands in the range the moment it merges. Requiring it to cite
// itself is a paradox you can only satisfy by amending a PR after opening it —
// and it is what failed the automation's very first run on main (#115 released
// nothing because its 1.12.0 section didn't cite #115).
test('auditRelease does not make a release cite the PR that wrote it', () => {
  const log = 'Merge pull request #93 from a/release\nMerge pull request #90 from a/b\nMerge pull request #91 from a/c';
  const cited = { version: '1.2.0', changelog: CL, tags: ['v1.1.0'], mergeLogSince: () => log };

  // On main, HEAD is that merge commit — #93 is exempt, the rest still required.
  const onMain = auditRelease({ ...cited, headMergePR: '93' });
  assert.equal(onMain.ok, true, onMain.message);
  assert.match(onMain.message, /all 2 non-dependabot/, 'the exempt PR is not counted');

  // On a pull_request, HEAD is a merge preview with no "Merge pull request #N"
  // subject, so nothing is exempt and an uncited PR is still caught.
  const onPr = auditRelease({ ...cited, headMergePR: null });
  assert.equal(onPr.ok, false, 'the PR-time audit keeps its full strength');
  assert.match(onPr.message, /#93/);

  // Exempting one PR must not excuse a different uncited one.
  const other = auditRelease({ ...cited, headMergePR: '90' });
  assert.equal(other.ok, false);
  assert.match(other.message, /#93/);
});

test('auditRelease FAILS a release missing a merged PR', () => {
  const r = auditRelease({
    version: '1.2.0', changelog: CL, tags: ['v1.1.0'],
    mergeLogSince: () => 'Merge pull request #90 from a/b\nMerge pull request #91 from a/c\nMerge pull request #93 from a/d',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'incomplete');
  assert.match(r.message, /#93/);
});

test('auditRelease PASSES a release that cites every non-dependabot PR', () => {
  const r = auditRelease({
    version: '1.2.0', changelog: CL, tags: ['v1.1.0'],
    mergeLogSince: () => 'Merge pull request #90 from a/b\nMerge pull request #91 from a/c\nMerge pull request #99 from a/dependabot/x',
  });
  assert.equal(r.ok, true, r.message);
});

// An in-flight bump with entries still under [Unreleased] stays green (a
// batch may let a later card own the dated section) — but since releases went
// automatic it releases nothing on merge, so the verdict's message warns to
// date the section in the PR (CLAUDE.md's PR protocol).
test('auditRelease PASSES an in-flight bump whose entries are under [Unreleased]', () => {
  const cl = '# Changelog\n\n## [Unreleased]\n### Added\n- a new thing\n\n## [1.1.0] — x\n- old\n';
  const r = auditRelease({ version: '1.2.0', changelog: cl, tags: ['v1.1.0'], mergeLogSince: () => 'Merge pull request #90 from a/b' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.code, 'unreleased');
});

test('auditRelease FAILS a version bump whose [Unreleased] section is empty', () => {
  const r = auditRelease({ version: '9.9.9', changelog: CL, tags: ['v1.1.0'], mergeLogSince: () => '' });
  assert.equal(r.code, 'empty-unreleased');
  assert.equal(r.ok, false);
});

test('auditRelease FAILS a version bump with no [Unreleased] section at all', () => {
  const cl = '# Changelog\n\n## [1.1.0] — x\n- old\n';
  const r = auditRelease({ version: '1.2.0', changelog: cl, tags: ['v1.1.0'], mergeLogSince: () => '' });
  assert.equal(r.code, 'no-section');
  assert.equal(r.ok, false);
});

test('auditRelease FAILS a tagged version whose section was deleted', () => {
  const cl = '# Changelog\n\n## [Unreleased]\n- something\n';
  const r = auditRelease({ version: '1.1.0', changelog: cl, tags: ['v1.1.0'], mergeLogSince: () => '' });
  assert.equal(r.code, 'no-section');
  assert.equal(r.ok, false);
});

// Naming the section for the version is what declares "this is the release" —
// and that is exactly when the merged-PR reconciliation must still bite.
test('auditRelease still reconciles merged PRs once the section is named for the version', () => {
  const cl = '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] — x\n- one thing (#90)\n\n## [1.1.0] — y\n- old\n';
  const r = auditRelease({
    version: '1.2.0', changelog: cl, tags: ['v1.1.0'],
    mergeLogSince: () => 'Merge pull request #90 from a/b\nMerge pull request #93 from a/d',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'incomplete');
  assert.match(r.message, /#93/);
});

test('auditRelease is a no-op on an already-tagged (non-release) version', () => {
  const r = auditRelease({ version: '1.1.0', changelog: CL, tags: ['v1.1.0'], mergeLogSince: () => 'anything' });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'not-release');
});

test('a citation of #8 does not satisfy a requirement for #88 (boundary)', () => {
  const cl = '## [2.0.0] — x\n- fixed something (#8)\n';
  const r = auditRelease({
    version: '2.0.0', changelog: cl, tags: ['v1.0.0'],
    mergeLogSince: () => 'Merge pull request #88 from a/b',
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /#88/);
});

test('first tagged release needs no reconciliation', () => {
  const r = auditRelease({ version: '1.0.0', changelog: '## [1.0.0] — x\n- hi\n', tags: [], mergeLogSince: () => 'Merge pull request #5 from a/b' });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'first-release');
});
