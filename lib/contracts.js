// Contracts: named, versioned text files one card publishes and others read.
// Content lives at data/contracts/<name>/<version>.<ext>; data/contracts/
// index.json maps each name to its version metadata. The rules (validation,
// versioning, dedupe) live here; routes in server.js only translate errors.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, writeJsonAtomic, writeFileAtomic } = require('./store');

const CONTRACTS_DIR = path.join(DATA_DIR, 'contracts');
const INDEX_FILE = path.join(CONTRACTS_DIR, 'index.json');

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;
const VERSION_RE = /^[1-9][0-9]{0,8}$/;
const MAX_BYTES = 1024 * 1024;
const MAX_TASK_ID = 100;
// Windows resolves these as devices even with an extension ("con.txt"), so a
// directory with one of these names would not behave like a directory there.
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

class ContractError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ContractError';
    this.status = status;
  }
}
const bad = (msg) => new ContractError(400, msg);

// Every path under data/contracts is built from values that passed one of these
// checks, never from raw request input.
function validName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) {
    throw bad('name must match ^[a-z0-9][a-z0-9._-]{0,63}$ and not contain ".."');
  }
  // A trailing dot is stripped by Windows, so "x." and "x" would share a dir.
  if (name.endsWith('.') || WINDOWS_DEVICE_RE.test(name.split('.')[0])) {
    throw bad('name is reserved or ends with "."');
  }
  return name;
}

function validExt(ext) {
  if (typeof ext !== 'string' || !EXT_RE.test(ext)) throw bad('ext must match ^[a-z0-9]{1,10}$');
  return ext;
}

// Accepts the integer or its string form (it arrives from a URL segment).
function validVersion(version) {
  const s = String(version);
  if (!VERSION_RE.test(s)) throw bad('version must be a positive integer');
  return Number(s);
}

function validTaskId(taskId) {
  if (taskId === undefined || taskId === null) return null;
  if (typeof taskId !== 'string' || !taskId || taskId.length > MAX_TASK_ID) {
    throw bad(`taskId must be a string of 1-${MAX_TASK_ID} characters, or null`);
  }
  return taskId;
}

function validContent(content) {
  if (typeof content !== 'string') throw bad('content must be a string');
  // NUL is the cheap, reliable tell for binary data; anything else is "text".
  if (content.includes('\0')) throw bad('content must be text (found a NUL byte)');
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_BYTES) throw bad(`content is ${buf.length} bytes; the limit is ${MAX_BYTES}`);
  return buf;
}

// A missing index is an empty store. A present-but-unreadable one must throw:
// treating it as empty would let the next publish overwrite every name's history.
function loadIndex() {
  let raw;
  try {
    raw = fs.readFileSync(INDEX_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(raw);
}

// Names like "constructor" pass NAME_RE, so never read the index by bare key.
function versionsOf(index, name) {
  return Object.hasOwn(index, name) && Array.isArray(index[name].versions) ? index[name].versions : [];
}

function contentPath(meta) {
  // Re-checked on read so a hand-edited index can't steer the path.
  return path.join(CONTRACTS_DIR, validName(meta.name), `${validVersion(meta.version)}.${validExt(meta.ext)}`);
}

function publish({ name, content, ext, taskId } = {}) {
  validName(name);
  const extension = validExt(ext === undefined || ext === null ? 'txt' : ext);
  const buf = validContent(content);
  const owner = validTaskId(taskId);

  const index = loadIndex();
  const versions = versionsOf(index, name);
  const latest = versions[versions.length - 1];
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (latest && latest.sha256 === sha256) return { contract: { ...latest }, created: false };

  const meta = {
    name,
    version: latest ? latest.version + 1 : 1,
    sha256,
    taskId: owner,
    publishedAt: new Date().toISOString(),
    ext: extension,
    bytes: buf.length,
  };

  // Content first, index second: a crash between the two leaves an orphan file
  // (overwritten by the next publish of this version), never an index entry
  // pointing at nothing.
  fs.mkdirSync(path.join(CONTRACTS_DIR, name), { recursive: true });
  writeFileAtomic(contentPath(meta), buf);
  index[name] = { versions: [...versions, meta] };
  writeJsonAtomic(INDEX_FILE, index);
  return { contract: { ...meta }, created: true };
}

function list() {
  const index = loadIndex();
  return Object.keys(index)
    .sort()
    .map((name) => versionsOf(index, name).at(-1))
    .filter(Boolean)
    .map((meta) => ({ ...meta }));
}

// Latest version when `version` is omitted. Returns { contract, content }.
function get(name, version) {
  validName(name);
  const wanted = version === undefined ? null : validVersion(version);
  const versions = versionsOf(loadIndex(), name);
  const meta = wanted === null ? versions.at(-1) : versions.find((v) => v.version === wanted);
  if (!meta) {
    throw new ContractError(404, wanted === null ? `no contract named "${name}"` : `"${name}" has no version ${wanted}`);
  }
  return { contract: { ...meta }, content: fs.readFileSync(contentPath(meta), 'utf8') };
}

module.exports = { publish, list, get, validName, validExt, ContractError, MAX_BYTES, CONTRACTS_DIR };
