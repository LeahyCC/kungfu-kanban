const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tokenMatches, parseCookies } = require('../lib/auth');

// --- tokenMatches --------------------------------------------------------

test('tokenMatches: exact match returns true', () => {
  assert.equal(tokenMatches('secret-token', 'secret-token'), true);
});

test('tokenMatches: wrong token returns false', () => {
  assert.equal(tokenMatches('wrong', 'secret-token'), false);
});

test('tokenMatches: empty/falsy candidate returns false without calling into crypto', () => {
  assert.equal(tokenMatches('', 'secret-token'), false);
  assert.equal(tokenMatches(null, 'secret-token'), false);
  assert.equal(tokenMatches(undefined, 'secret-token'), false);
});

test('tokenMatches: multibyte candidate with equal JS .length but different byte length returns false, not throw', () => {
  // 'é' (1 UTF-16 code unit) vs 'e' + combining-free multibyte char chosen so
  // candidate.length === token.length in JS terms, but UTF-8 byte lengths differ.
  const token = 'aaaaaaaa'; // 8 bytes
  const candidate = 'é'.repeat(8); // 8 JS chars, but 16 UTF-8 bytes ('é' is 2 bytes)
  assert.equal(candidate.length, token.length); // same JS string length
  assert.doesNotThrow(() => tokenMatches(candidate, token));
  assert.equal(tokenMatches(candidate, token), false);
});

test('tokenMatches: same string length, same byte length, different content returns false', () => {
  assert.equal(tokenMatches('abcdefgh', 'abcdefgi'), false);
});

// --- parseCookies ----------------------------------------------------------

function req(cookieHeader) {
  return { headers: { cookie: cookieHeader } };
}

test('parseCookies: parses a simple single cookie', () => {
  assert.deepEqual(parseCookies(req('kk_auth=abc123')), { kk_auth: 'abc123' });
});

test('parseCookies: parses multiple cookies separated by "; "', () => {
  assert.deepEqual(parseCookies(req('a=1; b=2; kk_auth=xyz')), { a: '1', b: '2', kk_auth: 'xyz' });
});

test('parseCookies: no cookie header returns an empty object', () => {
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('parseCookies: URI-decodes cookie values', () => {
  assert.deepEqual(parseCookies(req('kk_auth=' + encodeURIComponent('a b/c'))), { kk_auth: 'a b/c' });
});

test('parseCookies: malformed percent-encoding does not throw — falls back to the raw value', () => {
  assert.doesNotThrow(() => parseCookies(req('kk_auth=%E0%A4%A')));
  const out = parseCookies(req('kk_auth=%E0%A4%A'));
  assert.equal(out.kk_auth, '%E0%A4%A');
});

test('parseCookies: a value-less cookie ("name" with no "=") is skipped', () => {
  assert.deepEqual(parseCookies(req('flagonly; kk_auth=1')), { kk_auth: '1' });
});

test('parseCookies: trims whitespace around cookie names', () => {
  assert.deepEqual(parseCookies(req(' a=1 ;  kk_auth=2')), { a: '1', kk_auth: '2' });
});
