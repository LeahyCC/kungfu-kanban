#!/usr/bin/env node
// Cuts the release for whatever version `main` is carrying: an annotated tag
// plus a GitHub Release whose notes are the dated CHANGELOG section. Runs on
// every push to main (see .github/workflows/test.yml), so one merged PR is one
// release — the convention in CLAUDE.md.
//
// It NEVER commits. Tag and release only: `main` carries a ruleset that
// refuses direct pushes, so a release flow that had to write to the branch it
// was releasing would be blocked by the very protection it runs behind.
//
// Two deliberate no-ops, both silent successes rather than red builds:
//   - the version is already tagged (a docs-only PR that bumped nothing)
//   - the notes for this version are still under "## [Unreleased]"
// scripts/check-release.js is what nags about the second one at PR time.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sectionBody } = require('./check-release');

// The hand-written release titles in this repo read "v1.7.1 — Archive tab,
// command palette, budget enforcement": the version, then the headline. The
// first **bolded** phrase in a section is that headline often enough to be
// worth using, and falling back to the bare version is never wrong.
function titleFor(version, body) {
  const m = /\*\*(.+?)\*\*/s.exec(body || '');
  if (!m) return `v${version}`;
  const phrase = m[1].replace(/\s+/g, ' ').replace(/[.:]$/, '').trim();
  return phrase ? `v${version} — ${phrase}` : `v${version}`;
}

// Pure decision: what should happen for this version, given the tags that
// exist and the changelog as written. Exported for the tests.
function planRelease({ version, tags, changelog }) {
  if (!version) return { action: 'skip', reason: 'no version in package.json' };
  const tag = `v${version}`;
  if ((tags || []).includes(tag)) {
    return { action: 'skip', reason: `${tag} is already tagged — nothing to cut` };
  }
  const body = sectionBody(changelog, version);
  // A heading-only section is empty for our purposes — "### Fixed" with no
  // entries under it is not release notes.
  if (body === null || !body.replace(/^#+ .*$/gm, '').trim()) {
    return {
      action: 'skip',
      reason: `${tag} has no dated "## [${version}]" section with entries — notes are still in flight under [Unreleased]`,
    };
  }
  return { action: 'release', tag, title: titleFor(version, body), notes: body };
}

// Publishing is irreversible enough to be opt-in. Running this by hand to see
// what it WOULD do must not tag and publish — learned the hard way on
// 2026-07-29, when a local smoke run pushed a real v1.12.0 release that had to
// be deleted. CI sets CI=true; a human has to say --yes.
function isLive(argv = [], env = {}) {
  return !!env.CI || argv.includes('--yes');
}

function run() {
  // execFile with arg arrays — no shell, per the repo convention.
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const plan = planRelease({
    version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
    changelog: fs.readFileSync('CHANGELOG.md', 'utf8'),
    tags: git('tag').split('\n').map((s) => s.trim()).filter(Boolean),
  });

  if (plan.action === 'skip') {
    console.log(`· ${plan.reason}`);
    return;
  }

  if (!isLive(process.argv, process.env)) {
    console.log(`(dry run) would release ${plan.title}`); // title already carries the version
    console.log(`          notes: ${plan.notes.split('\n').length} lines from the ## [${plan.tag.slice(1)}] section`);
    console.log('          pass --yes (or run under CI) to actually tag and publish');
    return;
  }

  const notesFile = path.join(os.tmpdir(), `${plan.tag}-notes.md`);
  fs.writeFileSync(notesFile, `${plan.notes}\n`);

  // The tagger identity is the workflow's, not a person's — annotated because
  // every existing tag in this repo is, and `git describe` prefers them.
  git('-c', 'user.name=kungfu-kanban release', '-c', 'user.email=release@users.noreply.github.com',
    'tag', '-a', plan.tag, '-m', plan.title);
  git('push', 'origin', plan.tag);
  execFileSync('gh', ['release', 'create', plan.tag, '--title', plan.title, '--notes-file', notesFile], {
    stdio: 'inherit',
  });
  console.log(`✓ released ${plan.tag} — ${plan.title}`);
}

if (require.main === module) run();
module.exports = { planRelease, titleFor, isLive };
