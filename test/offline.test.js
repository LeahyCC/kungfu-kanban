const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detect } = require('../lib/offline');
const cooldown = require('../lib/cooldown');

// --- detect() message matrix -------------------------------------------

test('detect: connectivity failures from the CLI and Node match', () => {
  const positives = [
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'connect ECONNREFUSED 160.79.104.10:443',
    'read ECONNRESET',
    'connect ETIMEDOUT',
    'request to https://api.anthropic.com failed: fetch failed',
    'Connection error.',
    'connection timed out',
    'socket hang up',
    'dns lookup failed EAI_AGAIN',
    'unable to connect to the API',
  ];
  for (const p of positives) assert.ok(detect(p), p);
});

test('detect: normal task failures and empty input do not match', () => {
  const negatives = [
    'permission denied',
    'usage limit reached',
    'tests failed: expected 3 to equal 4',
    'claude exited with code 1',
    '',
    null,
    undefined,
  ];
  for (const n of negatives) assert.ok(!detect(n), String(n));
});

// The two detectors must stay disjoint: a subscription limit must never be
// treated as an outage, and vice versa (runner checks cooldown first).
test('detect: offline and cooldown detectors do not overlap', () => {
  assert.ok(!cooldown.detect('getaddrinfo ENOTFOUND api.anthropic.com'));
  assert.ok(!detect("You've hit your session limit · resets 11:30pm"));
});
