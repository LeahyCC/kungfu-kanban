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

// The repo convention (CLAUDE.md): every change bumps package.json and adds a
// line under [Unreleased]; only the release card renames that section to
// "## [X.Y.Z] — date". Demanding a version-named section for any untagged
// version contradicted that and failed 100% of PRs.
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
