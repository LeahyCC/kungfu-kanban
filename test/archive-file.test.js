// The archive reader is shared by lib/store.js and the read-only report
// scripts, which must never load lib/store (its boot sweep deletes files).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readArchiveFile } = require('../lib/archive-file');

test('readArchiveFile: append order, corrupt lines skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-arch-'));
  try {
    const file = path.join(dir, 'archive.jsonl');
    fs.writeFileSync(file, '{"id":"a"}\nnot json\n\n{"id":"b"}\n');
    assert.deepEqual(readArchiveFile(file).map((t) => t.id), ['a', 'b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readArchiveFile: a missing file is an empty archive', () => {
  assert.deepEqual(readArchiveFile(path.join(os.tmpdir(), 'kfk-no-such-archive.jsonl')), []);
});

test('the report scripts load without pulling in lib/store', () => {
  require('../scripts/flow-report');
  require('../scripts/jev-report');
  const loaded = Object.keys(require.cache).map((f) => f.replace(/\\/g, '/'));
  assert.ok(!loaded.some((f) => f.endsWith('/lib/store.js')), 'lib/store.js was loaded');
});
