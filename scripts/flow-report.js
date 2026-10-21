#!/usr/bin/env node
// How long cards wait, how often they are sent back, and how long they sit
// between done and merged: the "before" numbers for card contracts. Read-only:
// parses the data files directly instead of requiring lib/store, whose boot
// sweep deletes orphan transcripts and would be a surprising side effect for a
// report. Cards from before lib/transitions.js lack the new fields; their cells
// stay blank rather than guessing.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.KFK_DATA_DIR || path.join(__dirname, '..', 'data');

function readCards() {
  let live = [];
  try {
    live = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf8'));
  } catch {}
  let archived = [];
  try {
    archived = fs.readFileSync(path.join(DATA_DIR, 'archive.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {}
  const seen = new Set();
  return [...live, ...archived].filter((t) => {
    if (!t || typeof t !== 'object' || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// Milliseconds from `from` to `to`, or null when either is missing or
// unparsable, or the order is backwards. A backwards pair means the card went
// round again (sent back, then re-queued or re-done), so the two stamps belong
// to different laps and subtracting them would invent a number.
function gap(from, to) {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmtDuration(ms) {
  if (ms == null) return '';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return `${Math.round(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

// Pure: cards in, display rows and totals out. `waitMs` / `mergeMs` ride along
// on each row so callers (and tests) can read the raw numbers.
function summarize(cards) {
  const have = { queuedAt: 0, doneAt: 0, followUps: 0, sendBacks: 0, deps: 0 };
  const waits = [];
  const merges = [];
  const rows = cards.map((t) => {
    if (t.queuedAt) have.queuedAt++;
    if (t.doneAt) have.doneAt++;
    if (isCount(t.followUps)) have.followUps++;
    if (isCount(t.sendBacks)) have.sendBacks++;
    const hadDeps = Array.isArray(t.deps) ? t.deps.length > 0 : null;
    if (hadDeps) have.deps++;
    const waitMs = gap(t.queuedAt, t.startedAt);
    const mergeMs = gap(t.doneAt, t.prMergedAt);
    if (waitMs != null) waits.push(waitMs);
    if (mergeMs != null) merges.push(mergeMs);
    return {
      title: String(t.title || '').slice(0, 50),
      status: t.error ? 'error' : (t.status || '?'),
      queuedWait: fmtDuration(waitMs),
      deps: hadDeps == null ? '?' : hadDeps ? 'yes' : 'no',
      followUps: isCount(t.followUps) ? t.followUps : '',
      sendBacks: isCount(t.sendBacks) ? t.sendBacks : '',
      doneToMerged: fmtDuration(mergeMs),
      waitMs,
      mergeMs,
    };
  });
  const totals = {
    cards: cards.length,
    have,
    medianWaitMs: median(waits),
    waitCount: waits.length,
    medianMergeMs: median(merges),
    mergeCount: merges.length,
  };
  const med = (ms, n) => (n ? `${fmtDuration(ms)} (${n} cards)` : 'n/a');
  const line = `${totals.cards} cards. With queuedAt ${have.queuedAt}, doneAt ${have.doneAt}, ` +
    `followUps ${have.followUps}, sendBacks ${have.sendBacks}, deps ${have.deps}. ` +
    `Median queued wait ${med(totals.medianWaitMs, totals.waitCount)}; ` +
    `median done to merged ${med(totals.medianMergeMs, totals.mergeCount)}.`;
  return { rows, totals, line };
}

function main() {
  const cards = readCards();
  if (!cards.length) {
    console.log(`No cards found in ${DATA_DIR}.`);
    return;
  }
  const { rows, line } = summarize(cards);
  console.table(rows.map(({ waitMs, mergeMs, ...shown }) => shown));
  console.log(line);
}

if (require.main === module) main();
module.exports = { summarize };
