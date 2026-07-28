const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detect } = require('../lib/authgate');
const cooldown = require('../lib/cooldown');
const offline = require('../lib/offline');

// --- detect() message matrix -------------------------------------------
// hit()/clear() fire real notifications; like cooldown/offline, only the
// pure surface is tested here (the live checklist covers the transitions).

test('detect: logged-out CLI phrasings match', () => {
  const positives = [
    'Not logged in · Please run /login',
    'not logged in',
    'please run /login',
    'Invalid API key',
    'authentication_error: OAuth token expired',
    'authentication error',
    'OAuth token revoked',
    '401 Unauthorized',
  ];
  for (const p of positives) assert.ok(detect(p), p);
});

test('detect: normal failures and empty input do not match', () => {
  const negatives = [
    'permission denied',
    'usage limit reached',
    'ENOTFOUND api.anthropic.com',
    'tests failed: expected 401 status in response body',
    'claude exited with code 1',
    '',
    null,
    undefined,
  ];
  for (const n of negatives) assert.ok(!detect(n), String(n));
});

// The guards must stay disjoint: a logged-out CLI is neither a subscription
// limit nor an outage (runner checks cooldown/offline first).
test('detect: auth does not overlap cooldown or offline', () => {
  assert.ok(!cooldown.detect('Not logged in · Please run /login'));
  assert.ok(!offline.detect('Not logged in · Please run /login'));
  assert.ok(!detect("You've hit your session limit · resets 11:30pm"));
  assert.ok(!detect('getaddrinfo ENOTFOUND api.anthropic.com'));
});
