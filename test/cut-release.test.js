/* The per-PR release cutter's decision logic (scripts/cut-release.js).
 *
 * This runs on every push to main with `contents: write`, so the important
 * property is that it is BORING: it releases exactly once per version, and
 * every other situation is a silent no-op rather than a red build or a
 * duplicate tag. */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRelease, titleFor, isLive } = require('../scripts/cut-release.js');

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed
- something not ready to ship

## [1.12.0] — 2026-07-29

### Added
- **A terminal inside every card.** The real headline.
- a second entry

## [1.11.0] — 2026-07-29

### Added
- the previous release
`;

test('a dated section with entries releases once', () => {
  const plan = planRelease({ version: '1.12.0', tags: ['v1.11.0'], changelog: CHANGELOG });
  assert.equal(plan.action, 'release');
  assert.equal(plan.tag, 'v1.12.0');
  assert.match(plan.notes, /A terminal inside every card/);
  assert.doesNotMatch(plan.notes, /the previous release/, 'notes stop at the next section');
  assert.doesNotMatch(plan.notes, /not ready to ship/, 'Unreleased never leaks into a release');
});

test('an already-tagged version is a no-op, so re-runs cannot double-release', () => {
  const plan = planRelease({ version: '1.12.0', tags: ['v1.11.0', 'v1.12.0'], changelog: CHANGELOG });
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /already tagged/);
});

test('notes still under [Unreleased] are a no-op, not a failure', () => {
  // The docs-only / not-yet-dated case: main carries 1.13.0 but no dated section.
  const plan = planRelease({ version: '1.13.0', tags: ['v1.12.0'], changelog: CHANGELOG });
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /no dated .* section|in flight/);
});

test('a heading-only section counts as empty', () => {
  const empty = `# Changelog\n\n## [2.0.0] — 2026-07-29\n\n### Added\n\n## [1.0.0] — 2026-01-01\n\n- old\n`;
  const plan = planRelease({ version: '2.0.0', tags: [], changelog: empty });
  assert.equal(plan.action, 'skip', '"### Added" with nothing under it is not release notes');
});

test('a missing version never releases', () => {
  assert.equal(planRelease({ version: '', tags: [], changelog: CHANGELOG }).action, 'skip');
  assert.equal(planRelease({ version: undefined, tags: [], changelog: CHANGELOG }).action, 'skip');
});

// A local run must never publish. This exists because one did: a smoke run on
// 2026-07-29 pushed a real v1.12.0 that had to be deleted from the feed.
test('publishing is opt-in — a bare local run is a dry run', () => {
  assert.equal(isLive([], {}), false, 'running it by hand publishes nothing');
  assert.equal(isLive(['node', 'cut-release.js'], {}), false);
  assert.equal(isLive([], { CI: 'true' }), true, 'CI publishes');
  assert.equal(isLive(['--yes'], {}), true, 'an explicit --yes publishes');
});

test('the title takes the first bold headline, and degrades to the bare version', () => {
  assert.equal(titleFor('1.12.0', '- **The headline.** rest'), 'v1.12.0 — The headline');
  assert.equal(titleFor('1.12.0', '- **Wrapped\n  across lines:** rest'), 'v1.12.0 — Wrapped across lines');
  assert.equal(titleFor('1.12.0', '- no bold anywhere'), 'v1.12.0');
  assert.equal(titleFor('1.12.0', ''), 'v1.12.0');
  assert.equal(titleFor('1.12.0', '- ****'), 'v1.12.0', 'empty bold is not a headline');
});
