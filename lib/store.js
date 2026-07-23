// JSON-file persistence for tasks and settings.
const fs = require('fs');
const path = require('path');

// KFK_DATA_DIR lets a spawned test server point every lib/*.js that persists
// state at its own isolated directory instead of this checkout's data/ —
// required for test/server.integration.test.js to never touch what a
// concurrently-running unit test process is reading/writing.
const DATA_DIR = process.env.KFK_DATA_DIR || path.join(__dirname, '..', 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'transcripts');
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.jsonl');

fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Boot sweep: drop transcripts left behind by cards deleted before the
// delete handler cleaned up after itself.
function sweepOrphanTranscripts() {
  const ids = new Set(state.tasks.map((t) => t.id));
  for (const file of fs.readdirSync(TRANSCRIPTS_DIR)) {
    const id = file.replace(/\.jsonl$/, '');
    if (!ids.has(id)) fs.unlinkSync(path.join(TRANSCRIPTS_DIR, file));
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// The live file must exist at every instant, so we write the new content to
// .tmp first, then swap it into place via same-volume atomic rename. A crash
// at any point leaves the live file untouched or fully replaced, never absent.
// `backup` additionally copies the still-intact live file to .bak before the
// swap — kept for settings.json (small, rarely written) and for the shutdown
// flush of tasks.json, but dropped from the hot debounced tasks.json path,
// where it doubled write volume on every flush.
function writeJsonAtomic(file, obj, { pretty = true, backup = true } = {}) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  if (backup && fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(tmp, file);
}

const state = {
  tasks: readJson(TASKS_FILE, []),
  settings: {
    maxConcurrent: 2,
    defaultCwd: process.env.HOME || '',
    archiveDays: 7,
    ...readJson(SETTINGS_FILE, {}),
  },
};

// Anything that was mid-flight when the server last stopped is stale. The
// SIGTERM handler in server.js normally marks these before exit, but a crash
// or SIGKILL restart skips that — so label it here too rather than let an
// interrupted run masquerade as a clean finish.
for (const t of state.tasks) {
  if (t.status === 'running') {
    t.status = 'review';
    if (!t.error) t.error = 'interrupted by server restart';
  }
}

sweepOrphanTranscripts();

// Monotonic revision counter. Every task mutation bumps the task's `v` so
// clients can dirty-check cheaply (an id:v join instead of JSON.stringify),
// drop stale SSE echoes during optimistic updates, and refetch conditionally.
// `seq` is process-local; on boot it continues above the highest persisted v.
// Telemetry ticks (liveOut/ctxTokens) bump v like any other mutation — one
// counter, "v changed means anything may have changed".
state.seq = state.tasks.reduce((m, t) => Math.max(m, t.v || 0), 0);
function nextRev() {
  return ++state.seq;
}
function touch(task) {
  task.v = nextRev();
  return task;
}

// --- O(1) task index -------------------------------------------------------
// Map<id, task> beside state.tasks. The array's own mutating methods are
// wrapped to resync the index, so EVERY in-place mutation — including the
// unshift/splice sites in server.js, which this module does not own — keeps
// the Map honest. Two lazy repairs cover what wrapping can't see:
//   - reassignment (state.tasks = filtered) → detected by array reference
//   - length= truncation (tests) / any residual drift → length mismatch
// plus a find+reindex fallback when the Map misses an id that exists.
let taskIndex = new Map();
let indexedArray = null;
const INDEXED_MUTATORS = ['push', 'unshift', 'splice', 'pop', 'shift'];
function wrapTasksArray(arr) {
  for (const m of INDEXED_MUTATORS) {
    if (arr[m] && arr[m].__kkIndexed) continue; // already wrapped
    const wrapped = function (...args) {
      const res = Array.prototype[m].apply(this, args);
      reindex();
      return res;
    };
    wrapped.__kkIndexed = true;
    Object.defineProperty(arr, m, { value: wrapped, writable: true, configurable: true });
  }
}
function reindex() {
  indexedArray = state.tasks;
  taskIndex = new Map();
  for (const t of state.tasks) {
    if (t && t.id != null) taskIndex.set(t.id, t);
  }
  wrapTasksArray(state.tasks);
}
reindex();

function getTask(id) {
  if (state.tasks !== indexedArray || state.tasks.length !== taskIndex.size) reindex();
  const hit = taskIndex.get(id);
  if (hit) return hit;
  // The Map missed an id that exists (a mutation path nothing intercepted) —
  // find it once and rebuild so the next lookup is O(1) again.
  const found = state.tasks.find((t) => t.id === id);
  if (found) reindex();
  return found;
}

// --- transcript write buffering --------------------------------------------
// Transcript lines ride the save debounce instead of one appendFileSync per
// stream event: lines accumulate per task and flush as a single joined append.
// Runner close/error paths flush explicitly so no tail is lost; readTranscript
// merges the in-memory buffer so readers never see a stale file.
const transcriptBuffers = new Map(); // id -> [json line strings]

function transcriptPath(id) {
  return path.join(TRANSCRIPTS_DIR, `${id}.jsonl`);
}

function appendTranscript(id, entry) {
  const line = JSON.stringify(entry);
  const buf = transcriptBuffers.get(id);
  if (buf) buf.push(line);
  else transcriptBuffers.set(id, [line]);
  // Arm the debounce so transcript-only paths (no save() nearby) still reach
  // disk within the window instead of waiting for some later, unrelated save.
  scheduleSave();
}

function flushTranscripts(id) {
  if (id !== undefined) {
    const lines = transcriptBuffers.get(id);
    if (lines && lines.length) {
      transcriptBuffers.delete(id);
      try {
        fs.appendFileSync(transcriptPath(id), lines.join('\n') + '\n');
      } catch {}
    }
    return;
  }
  for (const [tid, lines] of transcriptBuffers) {
    if (!lines.length) continue;
    try {
      fs.appendFileSync(transcriptPath(tid), lines.join('\n') + '\n');
    } catch {}
  }
  transcriptBuffers.clear();
}

function readTranscript(id) {
  let entries = [];
  try {
    entries = fs
      .readFileSync(transcriptPath(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    entries = [];
  }
  const buf = transcriptBuffers.get(id);
  if (buf && buf.length) entries = entries.concat(buf.map((l) => JSON.parse(l)));
  return entries;
}

function clearTranscript(id) {
  transcriptBuffers.delete(id);
  try {
    fs.unlinkSync(transcriptPath(id));
  } catch {}
}

// --- debounced persistence ---------------------------------------------------
// tasks.json is machine state (compact, no per-flush .bak — tmp+rename is
// already crash-atomic); settings.json stays pretty with a .bak and is only
// written when a settings-mutating call site marked it dirty via saveSettings().
// 400ms debounce with a 2s max-wait cap so continuous streams (telemetry ticks)
// still flush periodically instead of starving under a resetting debounce.
const SAVE_DEBOUNCE_MS = 400;
const SAVE_MAX_WAIT_MS = 2000;
let saveTimer = null;
let maxTimer = null;
let tasksDirty = false;
let settingsDirty = false;

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  clearTimeout(maxTimer);
  maxTimer = null;
  flushTranscripts();
  if (tasksDirty) {
    tasksDirty = false;
    writeJsonAtomic(TASKS_FILE, state.tasks, { pretty: false, backup: false });
  }
  if (settingsDirty) {
    settingsDirty = false;
    writeJsonAtomic(SETTINGS_FILE, state.settings);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
  if (!maxTimer) {
    maxTimer = setTimeout(writeNow, SAVE_MAX_WAIT_MS);
    if (maxTimer.unref) maxTimer.unref();
  }
}

// Tasks-only save — the hot path. Settings mutations must call saveSettings().
function save() {
  tasksDirty = true;
  scheduleSave();
}

// Mark settings dirty and persist on the same debounce window as save().
function saveSettings() {
  settingsDirty = true;
  scheduleSave();
}

// Bypasses the debounce for shutdown, where there's no next tick to land on.
// Always writes both files here (tasks.json gets its .bak at shutdown): files
// this module doesn't own (cooldown.js, models.js) mutate state.settings
// without saveSettings(), and the shutdown flush is the last chance to persist
// those. The hot debounced path above is where the write reduction lives.
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  clearTimeout(maxTimer);
  maxTimer = null;
  flushTranscripts();
  tasksDirty = false;
  settingsDirty = false;
  writeJsonAtomic(TASKS_FILE, state.tasks, { pretty: false, backup: true });
  writeJsonAtomic(SETTINGS_FILE, state.settings);
}

// Moves "done" cards older than settings.archiveDays out of state.tasks and
// into data/archive.jsonl (append-only), dropping their transcript files.
function sweepArchive() {
  const days = state.settings.archiveDays;
  if (!days || days <= 0) return [];

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const archived = [];
  const keep = [];
  for (const t of state.tasks) {
    const ts = Date.parse(t.finishedAt || t.createdAt || '');
    if (t.status === 'done' && Number.isFinite(ts) && ts < cutoff) {
      archived.push(t);
    } else {
      keep.push(t);
    }
  }
  if (!archived.length) return [];

  for (const t of archived) {
    fs.appendFileSync(ARCHIVE_FILE, JSON.stringify(t) + '\n');
    clearTranscript(t.id);
  }
  state.tasks = keep;
  reindex(); // reassignment isn't visible to the wrapped mutators
  save();
  return archived;
}

module.exports = {
  state,
  save,
  saveSettings,
  flush,
  getTask,
  reindex,
  appendTranscript,
  flushTranscripts,
  readTranscript,
  clearTranscript,
  sweepArchive,
  writeJsonAtomic,
  nextRev,
  touch,
  DATA_DIR,
};
