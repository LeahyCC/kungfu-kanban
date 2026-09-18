const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Regression guard: lib/store reads KFK_DATA_DIR once at load time, and a
// test file that loads it without a temp dir reads (and can write or delete)
// the checkout's real data/, which from the main checkout is the live board.
// Every test file that requires a store-loading lib module must set up its
// own data dir BEFORE its first ../lib require.

// lib modules that never load store (directly or transitively).
const STORE_FREE = new Set(['bus', 'discovery', 'pty', 'schedule', 'skill', 'usage', 'version']);

test('every test file isolates its data dir before loading lib/store', () => {
  const dir = __dirname;
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const libs = [...src.matchAll(/require\('\.\.\/lib\/([\w-]+)'\)/g)];
    const loadsStore = libs.filter((m) => !STORE_FREE.has(m[1]));
    if (!loadsStore.length) continue;
    const firstLib = Math.min(...loadsStore.map((m) => m.index));
    const isolate = src.search(/KFK_DATA_DIR|helpers\/temp-data-dir/);
    if (isolate === -1 || isolate > firstLib) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `these load lib/store without a temp data dir first: ${offenders.join(', ')}`);
});
