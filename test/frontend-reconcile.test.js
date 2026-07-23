/* Frontend reconciler + SSE-helper tests (node --test, CommonJS; the app
 * modules are browser ESM and get dynamically imported AFTER the fake DOM is
 * installed as globals). Covers: keyed node reuse/patch/removal, scroll+focus
 * bookkeeping, revision keys with and without task.v, rAF coalescing, the
 * stale-echo drop, slim-payload merge, the haystack identity cache, optimistic
 * apply/rollback, and the transcript cap (tail kept, synthesized error entry,
 * sticky omitted-row). */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDom } = require('./helpers/fake-dom.js');

const dom = installFakeDom();

let state, optimistic, mergeTaskPayload;
let util, board, drawer;

test.before(async () => {
  ({ state, optimistic, mergeTaskPayload } = await import('../public/js/state.js'));
  util = await import('../public/js/util.js');
  board = await import('../public/js/board.js');
  drawer = await import('../public/js/drawer.js');
  dom.restoreTimers();
});

function mkTask(id, over = {}) {
  return {
    id,
    title: `Task ${id}`,
    status: 'backlog',
    prompt: `prompt ${id}`,
    cwd: '/repo',
    createdAt: '2026-07-01T00:00:00Z',
    ...over,
  };
}

function resetAll() {
  state.tasks = [];
  state.boardV = 0;
  optimistic.base.clear();
  board.__resetBoardForTests();
  drawer.__resetDrawerForTests();
  board.setFilter('');
  dom.document.activeElement = null;
  dom.document.querySelector('#transcript').innerHTML = '';
}

const backlogBody = () => {
  const boardEl = dom.document.querySelector('#board');
  const col = boardEl.querySelector('.column[data-status="backlog"]') || boardEl.children[0];
  return col.querySelector('.col-body');
};
const allCards = () => dom.document.querySelector('#board').querySelectorAll('.card');
const cardById = (id) => allCards().find((c) => c.dataset.id === id);

// ---------- keyed reconciler ----------

test('reconciler builds columns and reuses unchanged card nodes across renders', () => {
  resetAll();
  state.tasks = [mkTask('a'), mkTask('b', { v: 1 })];
  board.render();

  const cols = dom.document.querySelector('#board').children;
  assert.equal(cols.length, 5, 'five columns');
  assert.equal(allCards().length, 2);
  assert.equal(cols[0].getAttribute('role'), 'region');
  assert.match(cols[0].getAttribute('aria-label'), /Backlog column, 2 cards/);
  assert.equal(backlogBody().getAttribute('role'), 'list');
  assert.equal(cardById('a').getAttribute('role'), 'listitem');
  assert.equal(cardById('a').getAttribute('role') === 'button', false, 'no nested-interactive role');

  const elA = cardById('a');
  const elB = cardById('b');
  const writesA = elA._innerHTMLWrites;
  const writesB = elB._innerHTMLWrites;

  // add an unrelated card so the fingerprint gate passes; a and b must be
  // reused untouched (same element, no innerHTML rewrite)
  state.tasks = [...state.tasks, mkTask('c', { status: 'review', v: 9 })];
  board.render();
  assert.equal(allCards().length, 3);
  assert.equal(cardById('a'), elA, 'card a element reused');
  assert.equal(cardById('b'), elB, 'card b element reused');
  assert.equal(elA._innerHTMLWrites, writesA, 'card a not re-patched');
  assert.equal(elB._innerHTMLWrites, writesB, 'card b not re-patched');
});

test('v-path: replacing the object with the same v does NOT patch; a v bump does', () => {
  resetAll();
  state.tasks = [mkTask('a', { v: 5 })];
  board.render();
  const elA = cardById('a');
  const writes = elA._innerHTMLWrites;

  // same v, different title — "v changed ⇒ anything may have changed" cuts
  // both ways: unchanged v means the server says nothing changed
  state.tasks = [mkTask('a', { v: 5, title: 'Renamed silently' })];
  board.render();
  assert.equal(cardById('a'), elA);
  assert.equal(elA._innerHTMLWrites, writes, 'no patch while v is unchanged');

  state.tasks = [mkTask('a', { v: 6, title: 'Renamed for real' })];
  board.render();
  assert.equal(cardById('a'), elA, 'element still reused on patch');
  assert.equal(elA._innerHTMLWrites, writes + 1, 'patched exactly once on v bump');
  assert.match(elA.innerHTML, /Renamed for real/);
});

test('no-v fallback: shallow field compare patches only when rendered fields change', () => {
  resetAll();
  state.tasks = [mkTask('a')];
  board.render();
  const elA = cardById('a');
  const writes = elA._innerHTMLWrites;

  // identical content, fresh objects, plus a new card to pass the gate
  state.tasks = [mkTask('a'), mkTask('z', { status: 'done' })];
  board.render();
  assert.equal(cardById('a'), elA);
  assert.equal(elA._innerHTMLWrites, writes, 'identical fields → no re-patch');

  state.tasks = [mkTask('a', { title: 'Edited' }), state.tasks[1]];
  board.render();
  assert.equal(cardById('a'), elA);
  assert.equal(elA._innerHTMLWrites, writes + 1, 'rendered-field change patches');
});

test('dependency badge refreshes without the dependent card changing (dep-derived rev)', () => {
  resetAll();
  const dep = mkTask('dep', { status: 'review', v: 1 });
  const mine = mkTask('mine', { v: 1, deps: ['dep'] });
  state.tasks = [dep, mine];
  board.render();
  const elMine = cardById('mine');
  const writes = elMine._innerHTMLWrites;
  assert.match(elMine.innerHTML, /after:/, 'waiting-on badge while dep is unmet');

  // dep ships (ITS v bumps); mine's own v is untouched
  state.tasks = [mkTask('dep', { status: 'done', v: 2 }), mkTask('mine', { v: 1, deps: ['dep'] })];
  board.render();
  assert.equal(cardById('mine'), elMine);
  assert.equal(elMine._innerHTMLWrites, writes + 1, 'badge patched from the dep revision');
  assert.match(elMine.innerHTML, /deps met/);
});

test('stale nodes are removed; a card moving columns keeps its element', () => {
  resetAll();
  state.tasks = [mkTask('a', { v: 1 }), mkTask('b', { v: 1 })];
  board.render();
  const elA = cardById('a');

  // b deleted
  state.tasks = [state.tasks[0]];
  board.render();
  assert.equal(allCards().length, 1);
  assert.equal(cardById('b'), undefined, 'deleted card node gone');

  // a moves backlog → queued
  state.tasks = [mkTask('a', { v: 2, status: 'queued' })];
  board.render();
  assert.equal(cardById('a'), elA, 'same element moved, not recreated');
  assert.equal(elA.closest('.column').dataset.status, 'queued');
});

test('column scroll position and card focus survive a re-render', () => {
  resetAll();
  state.tasks = [mkTask('a'), mkTask('b')];
  board.render();
  const body = backlogBody();
  body.scrollTop = 42;
  const elA = cardById('a');
  elA.focus();
  assert.equal(dom.document.activeElement, elA);

  state.tasks = [mkTask('a', { title: 'Patched' }), mkTask('b'), mkTask('c')];
  board.render();
  assert.equal(backlogBody(), body, 'column body element persists (scroll never lost)');
  assert.equal(body.scrollTop, 42);
  assert.equal(dom.document.activeElement, elA, 'focused node reused → focus kept');
});

test('roving tabindex + ArrowDown/ArrowRight move focus between cards and columns', () => {
  resetAll();
  state.tasks = [mkTask('a'), mkTask('b'), mkTask('r', { status: 'review' })];
  board.render();
  const elA = cardById('a');
  const elB = cardById('b');
  const elR = cardById('r');
  assert.equal(elA.tabIndex, 0, 'first card in column is tabbable');
  assert.equal(elB.tabIndex, -1);

  const boardEl = dom.document.querySelector('#board');
  boardEl.dispatch('keydown', { target: elA, key: 'ArrowDown' });
  assert.equal(dom.document.activeElement, elB, 'ArrowDown moved focus');
  assert.equal(elB.tabIndex, 0);
  assert.equal(elA.tabIndex, -1);

  boardEl.dispatch('keydown', { target: elB, key: 'ArrowRight' });
  assert.equal(dom.document.activeElement, elR, 'ArrowRight crossed to the next non-empty column');
});

test('groups reconcile: wrapper reused, member moves group→ungrouped without loss', () => {
  resetAll();
  state.tasks = [mkTask('a', { group: 'G', v: 1 }), mkTask('b', { group: 'G', v: 1 })];
  board.render();
  const wrap = backlogBody().querySelector('.card-group');
  assert.ok(wrap, 'group wrapper rendered');
  assert.equal(wrap.querySelectorAll('.card').length, 2);
  const elA = cardById('a');

  // a leaves the group; must not be dropped by the cardsBox reconcile
  state.tasks = [mkTask('a', { v: 2 }), mkTask('b', { group: 'G', v: 1 })];
  board.render();
  assert.equal(cardById('a'), elA, 'card survived the group→ungrouped move');
  assert.equal(elA.closest('.card-group'), null);
  assert.equal(cardById('b').closest('.card-group'), wrap, 'group wrapper reused');
});

// ---------- rAF coalescing ----------

test('createCoalescer collapses N calls into one flush per frame', () => {
  const scheduled = [];
  let flushes = 0;
  const poke = util.createCoalescer(() => { flushes++; }, (cb) => scheduled.push(cb));
  poke(); poke(); poke(); poke(); poke();
  assert.equal(scheduled.length, 1, 'one frame scheduled for five calls');
  assert.equal(flushes, 0);
  scheduled.splice(0).forEach((cb) => cb());
  assert.equal(flushes, 1, 'single flush');
  poke();
  assert.equal(scheduled.length, 1, 're-arms for the next frame');
});

// ---------- stale-echo drop + slim merge ----------

test('stale-echo drop applies only with v present and v <= base', () => {
  resetAll();
  optimistic.note('x', { id: 'x', v: 5 });
  assert.equal(optimistic.isStaleEcho('x', 4), true);
  assert.equal(optimistic.isStaleEcho('x', 5), true, 'echo of the pre-mutation revision is stale');
  assert.equal(optimistic.isStaleEcho('x', 6), false, 'newer revision applies');
  assert.equal(optimistic.isStaleEcho('x', undefined), false, 'no v → today’s behavior');
  assert.equal(optimistic.isStaleEcho('y', 3), false, 'unknown id → applies');
  optimistic.clear('x');
  assert.equal(optimistic.isStaleEcho('x', 5), false, 'cleared after server caught up');
});

test('slim payload (full:false) merges; full payload replaces', () => {
  const existing = { id: 'a', title: 'T', prompt: 'heavy', resultText: 'heavy too' };
  const slim = { id: 'a', title: 'T2', v: 7, full: false };
  const merged = mergeTaskPayload(existing, slim);
  assert.deepEqual(merged, { id: 'a', title: 'T2', prompt: 'heavy', resultText: 'heavy too', v: 7, full: false });
  const full = { id: 'a', title: 'T3', prompt: 'new' };
  assert.equal(mergeTaskPayload(existing, full), full, 'no flag → wholesale replace (old behavior)');
});

// ---------- haystack cache ----------

test('haystack cache is identity-keyed: replacement invalidates, mutation does not', () => {
  const t1 = mkTask('a', { title: 'Alpha' });
  const h1 = board.haystackFor(t1);
  assert.match(h1, /alpha/);
  t1.title = 'Beta'; // mutating a cached object keeps the stale haystack…
  assert.match(board.haystackFor(t1), /alpha/, 'cache hit on identity');
  const t2 = { ...t1, title: 'Beta' }; // …but SSE/optimistic always replace objects
  assert.match(board.haystackFor(t2), /beta/, 'fresh object → fresh haystack');
  assert.doesNotMatch(board.haystackFor(t2), /alpha/);
});

// ---------- optimistic apply / rollback ----------

test('optimistic apply patches local state; rollback restores the snapshot object', () => {
  resetAll();
  const orig = mkTask('a', { v: 5 });
  state.tasks = [orig];
  board.render();

  const prev = board.applyOptimistic('a', { status: 'queued' });
  assert.equal(prev, orig);
  assert.equal(state.tasks[0].status, 'queued');
  assert.notEqual(state.tasks[0], orig, 'object replaced, not mutated (cache invalidation)');
  assert.equal(optimistic.isStaleEcho('a', 5), true, 'pre-mutation echo now dropped');
  assert.equal(cardById('a').closest('.column').dataset.status, 'queued', 'board re-rendered optimistically');

  board.rollbackOptimistic('a', prev);
  assert.equal(state.tasks[0], orig, 'snapshot object restored');
  assert.equal(state.tasks[0].status, 'backlog');
  assert.equal(optimistic.isStaleEcho('a', 5), false, 'guard cleared on rollback');
  assert.equal(cardById('a').closest('.column').dataset.status, 'backlog');
});

// ---------- transcript cap ----------

test('planTranscript keeps the tail, drops from the top, and appends a synthesized error entry', () => {
  const entries = Array.from({ length: 600 }, (_, i) => ({ kind: 'user', text: `line ${i}` }));
  const { shown, omitted } = drawer.planTranscript(entries, 'boom');
  assert.equal(shown.length, 500);
  assert.equal(omitted, 101, '600 entries + 1 synthesized − 500 kept');
  assert.equal(shown[shown.length - 1].kind, 'error', 'synthesized error survives at the tail');
  assert.equal(shown[shown.length - 1].text, 'boom');
  assert.equal(shown[0].text, 'line 101', 'oldest entries dropped from the top');

  // a permission block already in the log with the SAME text suppresses the synthesis
  const withBlocked = [...entries, { kind: 'blocked', text: 'boom' }];
  const p2 = drawer.planTranscript(withBlocked, 'boom');
  assert.equal(p2.omitted, 101);
  assert.equal(p2.shown[p2.shown.length - 1].kind, 'blocked', 'no duplicate error entry');
});

test('live transcript: rAF batching appends once per frame and enforces the cap with a sticky header', () => {
  resetAll();
  const box = dom.document.querySelector('#transcript');
  assert.equal(box.getAttribute('role'), 'log');
  assert.equal(box.getAttribute('aria-live'), 'polite');

  drawer.appendTranscriptEntry({ kind: 'user', text: 'one' });
  drawer.appendTranscriptEntry({ kind: 'user', text: 'two' });
  drawer.appendTranscriptEntry({ kind: 'user', text: 'three' });
  assert.equal(box.children.length, 0, 'nothing appended before the frame');
  dom.raf.flush();
  assert.equal(box.children.length, 3, 'one flush appended the batch');

  for (let i = 0; i < 600; i++) drawer.appendTranscriptEntry({ kind: 'user', text: `flood ${i}` });
  dom.raf.flush();
  const entries = box.children.length - 1; // minus the omitted header
  assert.equal(entries, 500, 'capped at 500 rendered entries');
  const head = box.firstChild;
  assert.ok(head.classList.contains('t-omitted'), 'sticky omitted header present');
  assert.match(head.textContent, /earlier output omitted — 103 entries/, 'drops counted from the top');
  assert.equal(box.children[box.children.length - 1].textContent, 'flood 599', 'tail kept');
});

// ---------- perf hook ----------

test('__kkPerf records render durations, capped at 500 entries', () => {
  resetAll();
  state.tasks = [mkTask('a')];
  board.render();
  state.tasks = [mkTask('a'), mkTask('b')];
  board.render();
  const perf = (globalThis.window.__kkPerf || globalThis.__kkPerf).renders;
  assert.ok(perf.length >= 2, 'renders recorded');
  assert.equal(typeof perf[perf.length - 1].ms, 'number');
  assert.equal(perf[perf.length - 1].cards, 2);
});
