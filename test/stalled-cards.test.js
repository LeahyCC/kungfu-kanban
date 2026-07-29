// Regressions for the 2026-07-28 stall: six finished cards sat in review with
// their PRs already merged, and the board reported nothing useful about why.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-stall-test-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/store');
// This file exercises the runner's park paths, which bridge Mac-sleep and fire
// desktop notifications. Left on, a test run leaks a 20-hour `caffeinate` that
// keeps node alive long after the assertions pass.
store.state.settings.notifyMac = false;
store.state.settings.keepAwake = false;

const { needsPrUrl } = require('../lib/prwatch');
const { exitError } = require('../lib/runner');
const { validTopic } = require('../lib/notify');
const authgate = require('../lib/authgate');
const cooldown = require('../lib/cooldown');

// --- the stall itself ---------------------------------------------------
// The agent opened its own PR under its own branch name, so the card's
// `gh pr create` came back "already exists" and left prUrl null. The sweep
// skips prUrl-less cards, so merging the PR never moved the card to done and
// every dependent stayed queued behind it.

test('needsPrUrl: a review card that opened a PR but never recorded it is adopted', () => {
  assert.equal(needsPrUrl({ status: 'review', prUrl: null, openPr: true, worktree: true, cwd: '/repo' }), true);
});

test('needsPrUrl: a done card whose PR was never seen to merge is adopted too', () => {
  // deps.js treats a done card with no prUrl as shipped, so an unmerged PR
  // silently releases every dependent unless the sweep can find it.
  const base = { status: 'done', prUrl: null, openPr: true, worktree: true, cwd: '/repo' };
  assert.equal(needsPrUrl(base), true);
  assert.equal(needsPrUrl({ ...base, prMergedAt: '2026-07-29T00:00:00Z' }), false, 'already known merged');
});

test('needsPrUrl: leaves alone anything the lookup must not touch', () => {
  const base = { status: 'review', prUrl: null, openPr: true, worktree: true, cwd: '/repo' };
  assert.equal(needsPrUrl({ ...base, prUrl: 'https://x/1' }), false, 'already tracked');
  assert.equal(needsPrUrl({ ...base, openPr: false }), false, 'card never wanted a PR');
  assert.equal(needsPrUrl({ ...base, worktree: false }), false, 'no worktree means no branch to look up');
  assert.equal(needsPrUrl({ ...base, cwd: null }), false, 'no repo to run gh in');
  assert.equal(needsPrUrl({ ...base, error: 'boom' }), false, 'a failed run never reached the PR flow');
  assert.equal(needsPrUrl({ ...base, prAdoptMisses: 3 }), false, 'stop re-shelling gh for a PR that is not there');
  assert.equal(needsPrUrl({ ...base, prAdoptMisses: 2 }), true, 'still within the retry budget');
  for (const status of ['backlog', 'queued', 'running']) {
    assert.equal(needsPrUrl({ ...base, status }), false, `${status} has no verdict to reconcile`);
  }
});

// --- the failure text the board threw away ------------------------------
// The CLI reports "Not logged in · Please run /login" on stdout (the result
// event) with stderr empty. Overwriting that with "claude exited with code 1"
// blinded the authgate/cooldown/offline detectors, so a logged-out CLI burned
// cards one at a time instead of pausing the board once.

test('exitError: keeps the CLI result text when stderr is empty', () => {
  const msg = 'Not logged in · Please run /login';
  assert.equal(exitError('', null, msg, 1), msg);
  assert.equal(authgate.detect(exitError('', null, msg, 1)), true, 'the auth gate can now see it');
});

test('exitError: prefers stderr, then an error already on the card, then the result', () => {
  assert.equal(exitError('  boom  ', 'prior', 'result', 1), 'boom');
  assert.equal(exitError('', 'prior', 'result', 1), 'prior');
  assert.equal(exitError('   ', null, 'result', 1), 'result');
});

test('exitError: falls back to the exit code when there is nothing else', () => {
  assert.equal(exitError('', null, null, 137), 'claude exited with code 137');
});

test('exitError: a limit message still reaches the cooldown detector', () => {
  const msg = "You've hit your session limit — resets at 3pm";
  assert.equal(cooldown.detect(exitError('', null, msg, 1)), true);
});

// --- push notifications ------------------------------------------------
// A topic the human disabled by editing it (kk-… prefixed with a sentinel)
// still got POSTed, earning an HTTP 400 per notification forever.

test('validTopic: accepts a real ntfy topic, rejects unset and edited-out ones', () => {
  assert.equal(validTopic('kk-3570a1f550640b00'), true);
  assert.equal(validTopic(''), false);
  assert.equal(validTopic(null), false);
  assert.equal(validTopic('<DISABLEREMOVETOENABLE>kk-3570a1f550640b00'), false);
  assert.equal(validTopic('has spaces'), false);
  assert.equal(validTopic('x'.repeat(65)), false);
});

// --- ▶ Run on a card that can't start yet -------------------------------
// Pressing Run on a dep-blocked card parked it and said nothing, so the button
// read as broken. Every refusal now carries a sentence the UI can show.

const { startTask } = require('../lib/runner');

test('startTask: a dep-blocked card parks with a reason naming the blocker', () => {
  store.state.tasks.length = 0;
  store.state.tasks.push(
    { id: 'dep', title: 'Phase 1', status: 'review', deps: [] },
    { id: 'kid', title: 'Phase 2', status: 'queued', deps: ['dep'] },
  );
  const r = startTask('kid');
  assert.equal(r.queued, true);
  assert.deepEqual(r.waitingOn, ['Phase 1']);
  assert.match(r.reason, /waits on Phase 1/);
  assert.equal(store.getTask('kid').status, 'queued', 'still parked, not launched');
});

test('startTask: a gated board parks with a reason naming the gate', () => {
  store.state.tasks.length = 0;
  store.state.tasks.push({ id: 'solo', title: 'Solo', status: 'queued', deps: [] });
  cooldown.hit("You've hit your session limit — resets at 3pm");
  try {
    const r = startTask('solo');
    assert.equal(r.queued, true);
    assert.equal(r.cooldown, true);
    assert.match(r.reason, /cooling down/);
    assert.equal(store.getTask('solo').status, 'queued', 'still parked, not launched');
  } finally {
    cooldown.clear();
    store.state.tasks.length = 0;
  }
});

// --- the Sensei's own logged-out runs -----------------------------------
// The CLI can answer with its trouble in prose and still report success, so
// the decision JSON fails to parse. That path used to log one unactionable
// error per trigger — 1331 copies of "Manager run errored: Not logged in"
// accumulated over six days instead of one pause.

const { pauseFor } = require('../lib/manager');

test('pauseFor: a logged-out message trips the auth gate instead of logging an error', () => {
  authgate.clear();
  assert.equal(pauseFor('Not logged in · Please run /login'), true);
  assert.equal(authgate.active(), true);
  authgate.clear();
});

test('pauseFor: a subscription limit trips the cooldown', () => {
  assert.equal(pauseFor('anything', true), true, 'an HTTP 429 is a limit regardless of the text');
  cooldown.clear();
});

test('pauseFor: an ordinary failure is left for the caller to log', () => {
  authgate.clear();
  assert.equal(pauseFor('gh pr create failed — base ref must be a branch'), false);
  assert.equal(authgate.active(), false);
});
