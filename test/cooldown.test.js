const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detect, parseReset } = require('../lib/cooldown');

// --- detect() message matrix -------------------------------------------

test('detect: every documented limit phrasing matches', () => {
  const positives = [
    "You've hit your session limit · resets 11:30pm",
    'usage limit reached',
    'rate limit exceeded, too many requests',
    'ratelimit exceeded',
    'session limit hit',
    'limit will reset at 3pm',
    'too many requests, please slow down',
    'out of extended usage',
    "you've hit your weekly limit",
  ];
  for (const p of positives) assert.ok(detect(p), p);
});

test('detect: unrelated errors and empty input do not match', () => {
  const negatives = ['some unrelated network error', 'ENOTFOUND', '', null, undefined, 'permission denied'];
  for (const n of negatives) assert.ok(!detect(n), String(n));
});

// --- parseReset() across message shapes ---------------------------------

test('parseReset: reads an embedded unix epoch (seconds) within the next 8 days', () => {
  const t = Date.now() + 3600_000;
  const epoch = Math.floor(t / 1000);
  const parsed = parseReset(`limit reached, resets at ${epoch}`);
  assert.equal(parsed, epoch * 1000);
});

test('parseReset: ignores an epoch that is already in the past, falling through to the next rule', () => {
  const past = Math.floor((Date.now() - 3600_000) / 1000);
  // epoch sits away from the word "resets" so the wall-clock regex has no
  // adjacent digits to (mis)grab as an hour — this exercises the hour-out fallback
  const before = Date.now();
  const parsed = parseReset(`epoch ${past} — resets unknown time`);
  assert.ok(parsed >= before + 59 * 60_000 && parsed <= before + 61 * 60_000);
});

test('parseReset: reads "resets 3pm" wall-clock phrasing', () => {
  const parsed = parseReset('resets 3pm');
  const d = new Date(parsed);
  assert.equal(d.getHours(), 15);
  assert.equal(d.getMinutes(), 0);
});

test('parseReset: reads "resets 11:30pm" with minutes', () => {
  const parsed = parseReset('resets 11:30pm');
  const d = new Date(parsed);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 30);
});

test('parseReset: 12am/12pm wall-clock edge cases', () => {
  const midnight = new Date(parseReset('resets 12am'));
  assert.equal(midnight.getHours(), 0);
  const noon = new Date(parseReset('resets 12pm'));
  assert.equal(noon.getHours(), 12);
});

test('parseReset: a wall-clock time already past today (same hour, :00) rolls to tomorrow', () => {
  // Any hour paired with ":00" is in the past the instant the clock's minutes
  // pass :00 — so "resets <this hour>" always names an already-passed time.
  const h = new Date().getHours();
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  const parsed = parseReset(`resets ${h12}${ap}`);
  assert.ok(parsed > Date.now());
  assert.equal(new Date(parsed).getHours(), h); // rolled a day forward, same hour
});

test('parseReset: "resets" with no am/pm defaults to 24h-style hour as given, no minutes', () => {
  const parsed = parseReset('limit hit, resets 9');
  const d = new Date(parsed);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
});

test('parseReset: falls back to an hour out when nothing matches', () => {
  const before = Date.now();
  const parsed = parseReset('no timing info here');
  assert.ok(parsed >= before + 59 * 60_000 && parsed <= before + 61 * 60_000);
});

test('parseReset: falls back to an hour out for empty/null input', () => {
  const before = Date.now();
  assert.ok(parseReset('') >= before + 59 * 60_000);
  assert.ok(parseReset(undefined) >= before + 59 * 60_000);
});
