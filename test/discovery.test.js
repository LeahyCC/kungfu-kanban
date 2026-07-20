const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultReposDir, countGitRepos } = require('../lib/discovery');

// Build a throwaway fake $HOME with the given "<subdir>/<repo>/.git" layout.
function fakeHome(layout) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-home-'));
  for (const [sub, repos] of Object.entries(layout)) {
    for (const r of repos) fs.mkdirSync(path.join(home, sub, r, '.git'), { recursive: true });
    if (!repos.length) fs.mkdirSync(path.join(home, sub), { recursive: true }); // empty dir
  }
  return home;
}

test('defaultReposDir picks the candidate holding the most git repos', () => {
  const home = fakeHome({ code: ['a', 'b'], projects: ['c'] });
  try {
    assert.equal(defaultReposDir(home), path.join(home, 'code'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('defaultReposDir falls back to $HOME when no candidate holds repos', () => {
  const home = fakeHome({ code: [] }); // exists but empty
  try {
    assert.equal(defaultReposDir(home), home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('defaultReposDir never invents ~/Documents/Code/Git out of thin air', () => {
  const home = fakeHome({}); // bare home, no dev folders at all
  try {
    // the old hardcoded default returned <home>/Documents/Code/Git even when
    // it did not exist — the fix must return the bare home instead
    assert.equal(defaultReposDir(home), home);
    assert.notEqual(defaultReposDir(home), path.join(home, 'Documents', 'Code', 'Git'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('countGitRepos returns -1 for a missing directory and 0 for an empty one', () => {
  const home = fakeHome({ empty: [] });
  try {
    assert.equal(countGitRepos(path.join(home, 'does-not-exist')), -1);
    assert.equal(countGitRepos(path.join(home, 'empty')), 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
