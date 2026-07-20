// Error tracker: every operational error or block on the board — permission
// stops, PRs opened against the wrong base branch, PR-flow/launch failures,
// Sensei action errors, subscription limits — lands here automatically so the
// human (or the Sensei, on request) can fix the OPERATION later instead of
// fishing failures out of transcripts. Deliberately not a code-bug tracker:
// failing tests belong to the card's own review flow, not this log.
//
// Entries live in data/errors.json. A repeat of an open entry (same kind +
// card + text) bumps its count instead of piling up rows, and entries
// auto-resolve when the thing they describe later succeeds (clean re-run,
// green PR, merge) — so the open list is always "what still needs a hand".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'errors.json');
const MAX_ENTRIES = 400; // history cap; resolved entries also age out (14 days)
const KINDS = ['permission', 'wrong-base', 'ci-failing', 'pr-flow', 'pr-conflict', 'run-failed', 'launch-failed', 'sensei', 'limit', 'import'];

let entries = [];
try {
  entries = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(entries)) entries = [];
} catch {}

let broadcast = () => {};
function setBroadcaster(fn) {
  broadcast = fn;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    prune();
    fs.writeFileSync(FILE, JSON.stringify(entries, null, 2));
  }, 150);
}

function prune() {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  entries = entries.filter((e) => !e.resolved || Date.parse(e.resolvedAt || 0) > cutoff);
  if (entries.length > MAX_ENTRIES) {
    // overflow drops resolved rows first, then the oldest open ones
    const open = entries.filter((e) => !e.resolved);
    const resolved = entries.filter((e) => e.resolved);
    entries = [...open.slice(-MAX_ENTRIES), ...resolved].slice(0, MAX_ENTRIES);
  }
}

function openCount() {
  return entries.filter((e) => !e.resolved).length;
}

function changed() {
  save();
  broadcast({ type: 'errors', open: openCount() });
}

// Record one error/block. A still-open entry with the same kind + card + text
// is the same problem happening again: bump its count, don't add a row.
function capture(kind, { taskId = null, taskTitle = null, text, detail = null } = {}) {
  if (!text) return null;
  text = String(text).replace(/\s+/g, ' ').trim().slice(0, 400);
  const dup = entries.find((e) => !e.resolved && e.kind === kind && e.taskId === taskId && e.text === text);
  if (dup) {
    dup.count = (dup.count || 1) + 1;
    dup.lastAt = new Date().toISOString();
    changed();
    return dup;
  }
  const entry = {
    id: crypto.randomBytes(4).toString('hex'),
    ts: new Date().toISOString(),
    lastAt: new Date().toISOString(),
    kind: KINDS.includes(kind) ? kind : 'run-failed',
    taskId,
    taskTitle: taskTitle ? String(taskTitle).slice(0, 200) : null,
    text,
    detail: detail ? String(detail).slice(0, 1000) : null,
    count: 1,
    resolved: false,
    resolvedAt: null,
    resolvedBy: null,
  };
  entries.push(entry);
  changed();
  return entry;
}

function markResolved(e, by) {
  e.resolved = true;
  e.resolvedAt = new Date().toISOString();
  e.resolvedBy = by;
}

function resolve(id, by = 'human') {
  const e = entries.find((x) => x.id === id && !x.resolved);
  if (!e) return null;
  markResolved(e, by);
  changed();
  return e;
}

function resolveAll(by = 'human') {
  let n = 0;
  for (const e of entries) {
    if (!e.resolved) { markResolved(e, by); n++; }
  }
  if (n) changed();
  return n;
}

// Auto-resolution: the failure's subject succeeded (clean re-run, green PR,
// merge, card deleted). kinds=null clears every open entry for the card.
function resolveTask(taskId, kinds = null, by = 'auto') {
  let n = 0;
  for (const e of entries) {
    if (e.resolved || e.taskId !== taskId) continue;
    if (kinds && !kinds.includes(e.kind)) continue;
    markResolved(e, by);
    n++;
  }
  if (n) changed();
  return n;
}

// Board-wide auto-resolution for taskless kinds (e.g. 'limit' when a cooldown ends).
function resolveKind(kind, by = 'auto') {
  let n = 0;
  for (const e of entries) {
    if (!e.resolved && e.kind === kind && !e.taskId) { markResolved(e, by); n++; }
  }
  if (n) changed();
  return n;
}

// Open entries first (newest activity on top), resolved history after.
function list() {
  const open = entries.filter((e) => !e.resolved);
  const done = entries.filter((e) => e.resolved);
  const byLast = (a, b) => Date.parse(b.lastAt || b.ts) - Date.parse(a.lastAt || a.ts);
  return [...open.sort(byLast), ...done.sort(byLast)];
}

// Compact projection for the Sensei prompt — ids are what resolve_error takes.
function forPrompt(max = 20) {
  return entries
    .filter((e) => !e.resolved)
    .slice(-max)
    .map((e) => ({
      errorId: e.id,
      kind: e.kind,
      at: e.lastAt,
      card: e.taskTitle || undefined,
      taskId: e.taskId || undefined,
      seen: e.count > 1 ? `${e.count}×` : undefined,
      text: e.text.slice(0, 250),
    }));
}

module.exports = { capture, resolve, resolveAll, resolveTask, resolveKind, list, forPrompt, openCount, setBroadcaster };
