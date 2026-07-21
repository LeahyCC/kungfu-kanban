'use strict';
// CI guard: a release PR — one that bumps package.json to a version not yet
// tagged — must have a CHANGELOG section that accounts for every non-dependabot
// PR merged since the previous release tag. Stops a release going out that
// under-reports what shipped (1.1.0 first went out missing five merged PRs).
//
// A no-op on ordinary PRs: when package.json's version is already tagged, the
// only requirement is that its changelog section exists.
const fs = require('fs');
const { execFileSync } = require('child_process');

// --- pure helpers (exported for tests) ------------------------------------

// The body text under "## [version] …" up to the next "## [" header (or EOF),
// or null if there's no such section. Sliced rather than regex-captured so a
// multi-line section isn't truncated at the first line-end.
function sectionBody(changelog, version) {
  const esc = version.replace(/[.]/g, '\\.');
  const header = changelog.match(new RegExp(`^## \\[${esc}\\][^\\n]*$`, 'm'));
  if (!header) return null;
  const rest = changelog.slice(header.index + header[0].length);
  const next = rest.search(/\n## \[/);
  return next === -1 ? rest : rest.slice(0, next);
}

// Highest vX.Y.Z tag strictly below `version`, or null.
function priorReleaseTag(tags, version) {
  const parse = (s) => s.replace(/^v/, '').split('.').map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const target = parse(version);
  return tags
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .filter((t) => cmp(parse(t), target) < 0)
    .sort((a, b) => cmp(parse(a), parse(b)))
    .pop() || null;
}

// PR numbers from `git log --merges` output, dropping dependabot branches
// (mechanical bumps are visible in the lockfile diff; citing them is optional).
function mergedPRNumbers(mergeLog) {
  const out = [];
  for (const m of mergeLog.matchAll(/Merge pull request #(\d+) from (\S+)/g)) {
    if (/dependabot/i.test(m[2])) continue;
    out.push(m[1]);
  }
  return [...new Set(out)];
}

// { ok, code, message }. code: no-section | not-release | first-release | incomplete | ok
function auditRelease({ version, changelog, tags, mergeLogSince }) {
  const body = sectionBody(changelog, version);
  if (body === null) {
    return { ok: false, code: 'no-section', message: `package.json is ${version} but CHANGELOG.md has no "## [${version}]" section.` };
  }
  if (tags.includes('v' + version)) {
    return { ok: true, code: 'not-release', message: `v${version} already tagged — not a new release; section present.` };
  }
  const prior = priorReleaseTag(tags, version);
  if (!prior) {
    return { ok: true, code: 'first-release', message: `${version} is the first tagged release — nothing prior to reconcile.` };
  }
  const prs = mergedPRNumbers(mergeLogSince(prior));
  const missing = prs.filter((pr) => !new RegExp(`#${pr}(?!\\d)`).test(body));
  if (missing.length) {
    return { ok: false, code: 'incomplete', message: `Release ${version} is missing changelog entries for ${missing.map((p) => '#' + p).join(', ')} (merged since ${prior}). Cite each in the ## [${version}] section, or omit only deliberately.` };
  }
  return { ok: true, code: 'ok', message: `Release ${version}: all ${prs.length} non-dependabot PR(s) since ${prior} are in the changelog.` };
}

// --- git/fs wiring (only when run directly) -------------------------------

function run() {
  // execFile with an arg array — no shell, per the repo convention. `tag` is
  // always a validated vX.Y.Z string from priorReleaseTag; never user input.
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const res = auditRelease({
    version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
    changelog: fs.readFileSync('CHANGELOG.md', 'utf8'),
    tags: git('tag').split('\n').map((s) => s.trim()).filter(Boolean),
    mergeLogSince: (tag) => git('log', `${tag}..HEAD`, '--merges', '--pretty=%s%n%b'),
  });
  console.log((res.ok ? '✓ ' : '✗ ') + res.message);
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) run();
module.exports = { sectionBody, priorReleaseTag, mergedPRNumbers, auditRelease };
