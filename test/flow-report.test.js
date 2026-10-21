const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarize } = require('../scripts/flow-report');

const T = (min) => new Date(Date.UTC(2026, 9, 1, 12, min, 0)).toISOString();

test('flow-report: a full card gets every column filled', () => {
  const { rows, totals } = summarize([{
    id: 'a', title: 'Full card', status: 'done', deps: ['x'],
    queuedAt: T(0), startedAt: T(30), doneAt: T(90), prMergedAt: T(100),
    followUps: 2, sendBacks: 1,
  }]);
  assert.equal(rows[0].queuedWait, '30m');
  assert.equal(rows[0].doneToMerged, '10m');
  assert.equal(rows[0].deps, 'yes');
  assert.equal(rows[0].followUps, 2);
  assert.equal(rows[0].sendBacks, 1);
  assert.deepEqual(totals.have, { queuedAt: 1, doneAt: 1, followUps: 1, sendBacks: 1, deps: 1 });
});

test('flow-report: an old card with none of the new fields gets blanks, never a number', () => {
  const { rows, totals, line } = summarize([{
    id: 'old', title: 'Old card', status: 'done', deps: [],
    createdAt: T(0), startedAt: T(5), finishedAt: T(20), prMergedAt: T(30),
  }]);
  assert.equal(rows[0].queuedWait, '');
  assert.equal(rows[0].doneToMerged, '');
  assert.equal(rows[0].followUps, '');
  assert.equal(rows[0].sendBacks, '');
  assert.equal(rows[0].deps, 'no');
  assert.equal(totals.medianWaitMs, null);
  assert.equal(totals.medianMergeMs, null);
  assert.deepEqual(totals.have, { queuedAt: 0, doneAt: 0, followUps: 0, sendBacks: 0, deps: 0 });
  assert.match(line, /1 cards/);
  assert.match(line, /Median queued wait n\/a/);
});

test('flow-report: a card with no deps array shows ? for deps', () => {
  const { rows } = summarize([{ id: 'b', title: 'No deps field', status: 'backlog' }]);
  assert.equal(rows[0].deps, '?');
  assert.equal(rows[0].status, 'backlog');
});

test('flow-report: stamps from different laps (start before queue, merge before done) give no gap', () => {
  const { rows, totals } = summarize([{
    id: 'c', title: 'Went round again', status: 'done',
    queuedAt: T(50), startedAt: T(10), doneAt: T(60), prMergedAt: T(40),
  }]);
  assert.equal(rows[0].queuedWait, '');
  assert.equal(rows[0].doneToMerged, '');
  assert.equal(totals.waitCount, 0);
  assert.equal(totals.mergeCount, 0);
});

test('flow-report: unparsable timestamps are treated as missing', () => {
  const { rows } = summarize([{ id: 'd', title: 'Bad', status: 'done', queuedAt: 'nope', startedAt: T(1) }]);
  assert.equal(rows[0].queuedWait, '');
});

test('flow-report: medians cover only the cards that have the pair (odd and even counts)', () => {
  const cards = [
    { id: '1', title: '1', queuedAt: T(0), startedAt: T(10) },
    { id: '2', title: '2', queuedAt: T(0), startedAt: T(20) },
    { id: '3', title: '3', queuedAt: T(0), startedAt: T(60) },
    { id: '4', title: '4' },
  ];
  let { totals } = summarize(cards);
  assert.equal(totals.cards, 4);
  assert.equal(totals.waitCount, 3);
  assert.equal(totals.medianWaitMs, 20 * 60_000);

  ({ totals } = summarize([...cards, { id: '5', title: '5', queuedAt: T(0), startedAt: T(30) }]));
  assert.equal(totals.waitCount, 4);
  assert.equal(totals.medianWaitMs, 25 * 60_000);
});

test('flow-report: median done-to-merged and the totals line', () => {
  const { totals, line } = summarize([
    { id: '1', title: '1', doneAt: T(0), prMergedAt: T(0) },
    { id: '2', title: '2', doneAt: T(0), prMergedAt: T(120) },
    { id: '3', title: '3', doneAt: T(0), prMergedAt: T(30), sendBacks: 0, followUps: 0 },
  ]);
  assert.equal(totals.medianMergeMs, 30 * 60_000);
  assert.match(line, /3 cards/);
  assert.match(line, /doneAt 3/);
  assert.match(line, /followUps 1/);
  assert.match(line, /median done to merged 30m \(3 cards\)/);
});

test('flow-report: a zero count is shown as 0, an absent one as blank', () => {
  const { rows } = summarize([
    { id: '1', title: 'zero', followUps: 0, sendBacks: 0 },
    { id: '2', title: 'absent' },
  ]);
  assert.equal(rows[0].followUps, 0);
  assert.equal(rows[1].followUps, '');
});

test('flow-report: an empty board does not throw', () => {
  const { rows, totals } = summarize([]);
  assert.deepEqual(rows, []);
  assert.equal(totals.cards, 0);
});
