// JSON-file persistence for tasks and settings.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'transcripts');

fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const state = {
  tasks: readJson(TASKS_FILE, []),
  settings: {
    maxConcurrent: 2,
    defaultCwd: process.env.HOME || '',
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
    fs.writeFileSync(TASKS_FILE, JSON.stringify(state.tasks, null, 2));
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state.settings, null, 2));
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

module.exports = { state, save, getTask, appendTranscript, readTranscript, clearTranscript };
