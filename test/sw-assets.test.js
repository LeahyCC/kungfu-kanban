/* Guards the service worker's app-shell asset list against module-graph drift:
   every ASSETS entry must exist on disk under public/, and every public/js/*.js
   file must be listed — a missed module would install an incoherent
   (mixed-version) shell, the exact failure this SW design exists to prevent. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const swSrc = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

function extractAssets() {
  const m = swSrc.match(/ASSETS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'sw.js declares an ASSETS array literal');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
  assert.ok(entries.length > 0, 'ASSETS is not empty');
  return entries;
}

test('VERSION constant is the single coherence knob', () => {
  assert.match(swSrc, /const VERSION = '[^']+'/, 'VERSION constant present');
  assert.ok(swSrc.includes("'kk-shell-' + VERSION"), 'cache name derives from VERSION');
});

test('every ASSETS path exists on disk under public/', () => {
  for (const p of extractAssets()) {
    const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
    assert.ok(fs.existsSync(path.join(pub, rel)), `${p} exists on disk`);
  }
});

test('every public/js/*.js module on disk IS listed in ASSETS', () => {
  const listed = new Set(extractAssets());
  assert.ok(listed.has('/app.js'), '/app.js is precached');
  for (const f of fs.readdirSync(path.join(pub, 'js'))) {
    if (f.endsWith('.js')) assert.ok(listed.has(`/js/${f}`), `/js/${f} is precached`);
  }
});

test('live endpoints bypass the cache (SSE untouched)', () => {
  assert.ok(swSrc.includes("startsWith('/api/')"), '/api/ bypass present');
  assert.ok(swSrc.includes('/login') && swSrc.includes('/logout'), 'auth routes bypassed');
});

test('install is atomic and stale shells are pruned', () => {
  assert.match(swSrc, /addAll/, 'single cache.addAll — all-or-nothing install');
  assert.match(swSrc, /caches\.delete/, 'old kk-shell-* caches deleted on activate');
  assert.match(swSrc, /skipWaiting/, 'skipWaiting on install');
  assert.match(swSrc, /clients\.claim/, 'clients.claim on activate');
});
