// JSON-file persistence for tasks and settings.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'transcripts');
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.jsonl');

fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// The live file must exist at every instant, so we write the new content to
// .tmp first, then back up the still-intact live file (copy, not rename), and
// only then swap .tmp into place via same-volume atomic rename. A crash at
// any point leaves the live file untouched or fully replaced, never absent.
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
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

// Anything that was mid-flight when the server last stopped is stale.
for (const t of state.tasks) {
  if (t.status === 'running') t.status = 'review';
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeJsonAtomic(TASKS_FILE, state.tasks);
    writeJsonAtomic(SETTINGS_FILE, state.settings);
  }, 150);
}

function getTask(id) {
  return state.tasks.find((t) => t.id === id);
}

function transcriptPath(id) {
  return path.join(TRANSCRIPTS_DIR, `${id}.jsonl`);
}

function appendTranscript(id, entry) {
  fs.appendFileSync(transcriptPath(id), JSON.stringify(entry) + '\n');
}

function readTranscript(id) {
  try {
    return fs
      .readFileSync(transcriptPath(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function clearTranscript(id) {
  try {
    fs.unlinkSync(transcriptPath(id));
  } catch {}
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
  save();
  return archived;
}

module.exports = { state, save, getTask, appendTranscript, readTranscript, clearTranscript, sweepArchive, writeJsonAtomic };
