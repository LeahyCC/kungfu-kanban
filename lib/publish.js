// Publishing a card's files as contracts. A card declares `publishes: [{ name,
// path }]`; when a worktree card finishes cleanly (or on demand via
// POST /api/tasks/:id/publish) each path is read from the card's worktree and
// handed to lib/contracts.js, which owns versioning and dedupe. This module
// owns the part contracts.js can't know about: which files a card may read.
const fs = require('fs');
const path = require('path');
const contracts = require('./contracts');
const { appendTranscript, save } = require('./store');
const errlog = require('./errlog');
const { broadcast } = require('./bus');

const MAX_PATH = 300;
const MAX_PUBLISHES = 20;

// Pure path check. Contract names reuse contracts.validName so a name that is
// valid here is valid there; only the repo-relative path rules live here.
// Throws Error with a message fit for an import warning or a 400.
function parseEntry(name, filePath) {
  contracts.validName(name);
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > MAX_PATH || filePath.includes('\0')) {
    throw new Error(`path must be a non-empty string of at most ${MAX_PATH} characters`);
  }
  const raw = filePath.trim();
  // A drive letter ("C:x") is relative on Windows yet escapes the worktree root,
  // and ":" also opens NTFS alternate streams, so no path may contain one.
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.includes(':')) {
    throw new Error('path must be relative to the repo root');
  }
  const segments = raw.split(/[\\/]+/).filter((s) => s && s !== '.');
  if (segments.includes('..')) throw new Error('path must not contain a ".." segment');
  if (!segments.length) throw new Error('path must name a file');
  return { name, path: segments.join('/') };
}

// API input → [{ name, path }]. Throws on the first bad entry.
function normalize(list) {
  if (!Array.isArray(list)) throw new Error('publishes must be an array of { name, path }');
  if (list.length > MAX_PUBLISHES) throw new Error(`publishes is limited to ${MAX_PUBLISHES} entries`);
  return list.map((e) => {
    if (!e || typeof e !== 'object') throw new Error('each publishes entry must be { name, path }');
    return parseEntry(e.name, e.path);
  });
}

// "<name> <path-in-repo>" (the importer line) → one entry. A path with spaces
// is fine: only the first run of whitespace separates the name.
function parseLine(value) {
  const m = String(value).trim().match(/^(\S+)\s+(.+)$/);
  if (!m) throw new Error('expected "<name> <path-in-repo>"');
  return parseEntry(m[1], m[2]);
}

// The stored extension: the file's own, if contracts would accept it.
function extOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  try {
    return contracts.validExt(ext);
  } catch {
    return 'txt';
  }
}

// Reads one declared file from `root` (a realpath'd worktree). Returns the
// content or throws Error. The realpath check is what stops a symlink the agent
// committed from reading ~/.ssh or the board's own data/ into a contract.
function readInside(root, rel) {
  let real;
  try {
    real = fs.realpathSync(path.join(root, rel));
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'file not found' : `cannot resolve file: ${e.message}`);
  }
  const back = path.relative(root, real);
  if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new Error('resolves outside the worktree');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > contracts.MAX_BYTES) throw new Error(`file is ${st.size} bytes; the limit is ${contracts.MAX_BYTES}`);
  return { content: fs.readFileSync(real, 'utf8'), ext: extOf(real) };
}

// Publishes every `task.publishes` file from the card's worktree. Never throws:
// each failure is a note on the card's transcript plus an error-tracker entry,
// because a missing deliverable must be visible but must not fail the card.
// Resolves { error } when there is no worktree to read at all, otherwise
// { published, unchanged, problems } (all string/object lists).
async function publishTask(task) {
  const prflow = require('./prflow'); // lazy: prflow needs store/errlog, importer needs this file
  const entries = Array.isArray(task.publishes) ? task.publishes : [];
  const out = { published: [], unchanged: [], problems: [] };
  if (!entries.length) return out;

  const note = (kind, text) => {
    appendTranscript(task.id, { kind, text });
    broadcast({ type: 'output', taskId: task.id, entry: { kind, text } });
  };
  const problem = (text) => {
    out.problems.push(text);
    note('error', `publish: ${text}`);
    errlog.capture('publish', { taskId: task.id, taskTitle: task.title, text });
  };

  // A rerun that now succeeds supersedes the earlier run's complaints.
  errlog.resolveTask(task.id, ['publish']);

  const wt = await prflow.findWorktree(task.cwd, `kanban-${task.id.slice(0, 8)}`);
  if (!wt) {
    const text = `no worktree matching "kanban-${task.id.slice(0, 8)}" found in ${task.cwd}`;
    problem(text);
    return { ...out, error: text };
  }
  let root;
  try {
    root = fs.realpathSync(wt.path);
  } catch (e) {
    const text = `worktree ${wt.path} is not readable: ${e.message}`;
    problem(text);
    return { ...out, error: text };
  }

  for (const entry of entries) {
    try {
      const { content, ext } = readInside(root, entry.path);
      const { contract, created } = contracts.publish({ name: entry.name, content, ext, taskId: task.id });
      if (!created) {
        out.unchanged.push({ name: contract.name, version: contract.version });
        note('init', `publish: ${entry.path} is unchanged, contract ${contract.name} stays at v${contract.version}`);
        continue;
      }
      const record = {
        name: contract.name, version: contract.version, sha256: contract.sha256, publishedAt: contract.publishedAt,
      };
      task.published = [...(task.published || []), record];
      out.published.push(record);
      note('init', `publish: ${entry.path} is now contract ${contract.name} v${contract.version}`);
    } catch (e) {
      problem(`${entry.name} (${entry.path}): ${e.message}`);
    }
  }
  save();
  broadcast({ type: 'task', task });
  return out;
}

module.exports = { parseEntry, parseLine, normalize, publishTask, MAX_PUBLISHES };
