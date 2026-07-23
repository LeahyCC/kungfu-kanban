// auth.js token cache: getToken() must read data/auth-token once, re-read only
// when the file's mtime changes, and keep the per-request gate semantics
// (wrong token still rejected). KFK_DATA_DIR is set before any lib require so
// the checkout's data/ is never touched. KFK_TOKEN must be unset — the env
// branch bypasses the file cache entirely.
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kfk-auth-cache-'));
delete process.env.KFK_TOKEN;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const auth = require('../lib/auth');

// Count reads of the token file only. Patch after require: auth.js holds the
// same fs module instance, so this intercepts its fs.readFileSync calls.
const realRead = fs.readFileSync;
let tokenReads = 0;
fs.readFileSync = function (p, ...rest) {
  if (String(p) === auth.TOKEN_FILE) tokenReads++;
  return realRead.call(this, p, ...rest);
};

after(() => {
  fs.readFileSync = realRead;
  fs.rmSync(process.env.KFK_DATA_DIR, { recursive: true, force: true });
});

function bumpMtime(offsetMs) {
  const t = new Date(Date.now() + offsetMs);
  fs.utimesSync(auth.TOKEN_FILE, t, t);
}

test('getToken reads the token file once across repeated calls', () => {
  fs.writeFileSync(auth.TOKEN_FILE, 'tok-one\n');
  assert.equal(auth.getToken(), 'tok-one');
  assert.equal(tokenReads, 1);
  assert.equal(auth.getToken(), 'tok-one');
  assert.equal(auth.getToken(), 'tok-one');
  assert.equal(tokenReads, 1, 'subsequent calls stat but never re-read');
});

test('getToken re-reads when the token file mtime changes', () => {
  fs.writeFileSync(auth.TOKEN_FILE, 'tok-two\n');
  bumpMtime(5000); // a same-ms rewrite must not pass as "unchanged"
  assert.equal(auth.getToken(), 'tok-two');
  assert.equal(tokenReads, 2);
  assert.equal(auth.getToken(), 'tok-two');
  assert.equal(tokenReads, 2);
});

test('a missing token file yields null and the absence is cached', () => {
  fs.rmSync(auth.TOKEN_FILE, { force: true });
  assert.equal(auth.getToken(), null);
  const before = tokenReads;
  assert.equal(auth.getToken(), null);
  assert.equal(tokenReads, before, 'no read attempts while the file stays absent');
});

test('gate semantics unchanged: wrong token rejected, right token accepted', () => {
  fs.writeFileSync(auth.TOKEN_FILE, 'tok-three\n');
  bumpMtime(9000);
  const token = auth.getToken();
  assert.equal(token, 'tok-three');
  assert.equal(auth.tokenMatches('tok-three', token), true);
  assert.equal(auth.tokenMatches('nope', token), false);
  assert.equal(auth.tokenMatches('', token), false);
  assert.equal(auth.tokenMatches(null, token), false);
  assert.equal(auth.tokenMatches('tok-three-plus-extra', token), false);
});
