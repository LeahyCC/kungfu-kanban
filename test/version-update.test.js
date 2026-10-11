const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { update, disposableVersionFile } = require('../lib/version');

const HEAD_LOG = `# Changelog

## [Unreleased]

## [1.0.0] — 2026-01-01

- base
`;

const LOCAL_BUMP_LOG = `# Changelog

## [Unreleased]

## [1.1.0] — 2026-06-01

- mid

## [1.0.0] — 2026-01-01

- base
`;

const ORIGIN_LOG = `# Changelog

## [Unreleased]

## [1.2.0] — 2026-10-11

- shipped

## [1.1.0] — 2026-06-01

- mid

## [1.0.0] — 2026-01-01

- base
`;

function pkg(version, extra = {}) {
  return `${JSON.stringify({ name: 'kungfu-kanban', version, ...extra }, null, 2)}\n`;
}

test('disposableVersionFile: superseded version bump and its changelog section are not user work', () => {
  assert.equal(disposableVersionFile('package.json', pkg('1.0.0'), pkg('1.1.0'), pkg('1.2.0')), true);
  assert.equal(disposableVersionFile('CHANGELOG.md', HEAD_LOG, LOCAL_BUMP_LOG, ORIGIN_LOG), true);
  assert.equal(disposableVersionFile('package.json', pkg('1.0.0'), pkg('1.2.0'), pkg('1.2.0')), true);
  assert.equal(disposableVersionFile('CHANGELOG.md', HEAD_LOG, ORIGIN_LOG, ORIGIN_LOG), true);
});

test('disposableVersionFile: formatter noise against HEAD is not user work', () => {
  const compact = '{"name":"kungfu-kanban","version":"1.0.0"}\n';
  assert.equal(disposableVersionFile('package.json', pkg('1.0.0'), compact, pkg('1.2.0')), true);
  assert.equal(disposableVersionFile('CHANGELOG.md', HEAD_LOG, HEAD_LOG.replace('\n\n', '\n\n\n'), ORIGIN_LOG), true);
  assert.equal(disposableVersionFile('CHANGELOG.md', HEAD_LOG, HEAD_LOG.replace(/\n/g, '\r\n'), ORIGIN_LOG), true);
});

test('disposableVersionFile: a private changelog line, a dependency, a downgrade, or a newer version stays', () => {
  const privateLog = LOCAL_BUMP_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- private note\n');
  assert.equal(disposableVersionFile('CHANGELOG.md', HEAD_LOG, privateLog, ORIGIN_LOG), false);
  assert.equal(
    disposableVersionFile('package.json', pkg('1.0.0'), pkg('1.1.0', { description: 'mine' }), pkg('1.2.0')),
    false,
  );
  assert.equal(disposableVersionFile('package.json', pkg('1.5.0'), pkg('1.4.0'), pkg('1.6.0')), false);
  assert.equal(disposableVersionFile('package.json', pkg('1.0.0'), pkg('9.0.0'), pkg('1.2.0')), false);
  assert.equal(disposableVersionFile('README.md', 'a\n', 'a\n', 'b\n'), false);
});

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function writeRelease(dir, version, changelog, extra = {}) {
  fs.writeFileSync(path.join(dir, 'package.json'), pkg(version, extra.pkg || {}));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  if (extra.readme != null) fs.writeFileSync(path.join(dir, 'README.md'), extra.readme);
  if (extra.notes != null) fs.writeFileSync(path.join(dir, 'notes.txt'), extra.notes);
}

async function withRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-upd-'));
  const bare = path.join(dir, 'origin.git');
  const pub = path.join(dir, 'pub');
  const local = path.join(dir, 'local');
  try {
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    fs.mkdirSync(pub);
    git(pub, ['init', '-q', '-b', 'main']);
    git(pub, ['remote', 'add', 'origin', bare]);
    writeRelease(pub, '1.0.0', HEAD_LOG, { readme: 'readme v1\n', notes: 'notes v1\n' });
    git(pub, ['add', '-A']);
    git(pub, ['commit', '-qm', 'v1']);
    git(pub, ['push', '-q', 'origin', 'main']);
    execFileSync('git', ['clone', '-q', bare, local]);
    await fn({ pub, local });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function publish(pub, version, changelog, extra) {
  writeRelease(pub, version, changelog, extra);
  git(pub, ['add', '-A']);
  git(pub, ['commit', '-qm', `v${version}`]);
  git(pub, ['push', '-q', 'origin', 'main']);
}

function headOf(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

test('update: fast-forwards over changelog and package.json dirt origin already contains', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG);
    writeRelease(local, '1.1.0', LOCAL_BUMP_LOG);
    const before = fs.readFileSync(path.join(local, 'notes.txt'), 'utf8');
    const result = await update({ root: local, runNpm: false });
    assert.equal(headOf(local), headOf(pub));
    assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).version, '1.2.0');
    assert.match(fs.readFileSync(path.join(local, 'CHANGELOG.md'), 'utf8'), /shipped/);
    assert.equal(fs.readFileSync(path.join(local, 'notes.txt'), 'utf8'), before);
    assert.equal(git(local, ['status', '--porcelain']).trim(), '');
    assert.match(result.output, /Fast-forward|1\.2\.0|v1\.2\.0|files? changed|origin\/main/i);
  });
});

test('update: exact origin copies of the version files do not abort the fast-forward', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG);
    writeRelease(local, '1.2.0', ORIGIN_LOG);
    await update({ root: local, runNpm: false });
    assert.equal(headOf(local), headOf(pub));
    assert.equal(git(local, ['status', '--porcelain']).trim(), '');
  });
});

test('update: formatting-only version files do not abort the fast-forward', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG);
    fs.writeFileSync(path.join(local, 'package.json'), '{"name":"kungfu-kanban","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(local, 'CHANGELOG.md'), HEAD_LOG.replace('\n\n## [1.0.0]', '\n\n\n## [1.0.0]'));
    await update({ root: local, runNpm: false });
    assert.equal(headOf(local), headOf(pub));
    assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).version, '1.2.0');
  });
});

test('update: a private changelog line aborts and is preserved', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG);
    const dirty = LOCAL_BUMP_LOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- private note\n');
    writeRelease(local, '1.1.0', dirty);
    const before = headOf(local);
    await assert.rejects(() => update({ root: local, runNpm: false }), /would be overwritten/);
    assert.equal(headOf(local), before);
    assert.match(fs.readFileSync(path.join(local, 'CHANGELOG.md'), 'utf8'), /private note/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).version, '1.1.0');
  });
});

test('update: a package.json dependency origin lacks aborts and is preserved', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG);
    writeRelease(local, '1.1.0', LOCAL_BUMP_LOG, { pkg: { description: 'mine' } });
    const before = headOf(local);
    await assert.rejects(() => update({ root: local, runNpm: false }), /would be overwritten/);
    assert.equal(headOf(local), before);
    const body = JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8'));
    assert.equal(body.description, 'mine');
    assert.equal(body.version, '1.1.0');
  });
});

test('update: does not discard an unrelated file the merge would overwrite', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG, { readme: 'readme from origin\n' });
    writeRelease(local, '1.1.0', LOCAL_BUMP_LOG);
    fs.writeFileSync(path.join(local, 'README.md'), 'local readme edit\n');
    const before = headOf(local);
    await assert.rejects(() => update({ root: local, runNpm: false }), /would be overwritten/);
    assert.equal(headOf(local), before);
    assert.equal(fs.readFileSync(path.join(local, 'README.md'), 'utf8'), 'local readme edit\n');
    assert.match(fs.readFileSync(path.join(local, 'CHANGELOG.md'), 'utf8'), /## \[1\.1\.0\]/);
  });
});

test('update: keeps a staged package.json edit that origin does not have', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG);
    writeRelease(local, '1.1.0', LOCAL_BUMP_LOG, { pkg: { description: 'staged' } });
    git(local, ['add', 'package.json']);
    const before = headOf(local);
    await assert.rejects(() => update({ root: local, runNpm: false }), /would be overwritten/);
    assert.equal(headOf(local), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).description, 'staged');
  });
});

test('update: keeps local edits the incoming merge does not touch', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG);
    writeRelease(local, '1.1.0', LOCAL_BUMP_LOG);
    fs.writeFileSync(path.join(local, 'notes.txt'), 'local notes\n');
    await update({ root: local, runNpm: false });
    assert.equal(headOf(local), headOf(pub));
    assert.equal(fs.readFileSync(path.join(local, 'notes.txt'), 'utf8'), 'local notes\n');
    assert.match(git(local, ['status', '--porcelain']), /notes\.txt/);
  });
});

test('update: a clean checkout still fast-forwards', async () => {
  await withRepo(async ({ pub, local }) => {
    publish(pub, '1.2.0', ORIGIN_LOG);
    await update({ root: local, runNpm: false });
    assert.equal(headOf(local), headOf(pub));
    assert.equal(git(local, ['status', '--porcelain']).trim(), '');
  });
});
