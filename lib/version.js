// Board update check + self-update, built on git so it works for any clone
// (and any fork — it compares against whatever `origin` is). The status line
// shows the local version; when the clone is behind origin/main it grows an
// update button that fast-forwards and restarts the server.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Every release edits these two files, and so does a checkout that is
// preparing one: the version field, the matching changelog section, or a
// formatter pass over them. The Update button only appears when origin/main
// is a newer version, so the incoming commits touch the same files. git
// aborts a merge on any overlap — including dirt origin already contains.
// That dirt is not user work. A unique edit, or any other dirty path the
// merge would overwrite, is, and stays where it is so the merge still refuses.
const VERSION_FILES = ['CHANGELOG.md', 'package.json'];

function git(args, timeout = 30_000) {
  return new Promise((resolve) =>
    execFile('git', args, { cwd: ROOT, timeout }, (err, stdout) => resolve(err ? null : stdout.trim()))
  );
}

function gitAt(root, args, { timeout = 30_000, trim = true } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = stdout || '';
      resolve({
        ok: !err,
        out: trim ? out.trim() : out,
        err: (stderr || (err && err.message) || '').trim(),
      });
    });
  });
}

function localVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

let cache = { at: 0, data: null };

// "1.2.3" > "1.2.2"? (plain numeric semver; anything unparsable loses)
function newer(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function check(force = false) {
  if (!force && cache.data && Date.now() - cache.at < 30 * 60_000) return cache.data;
  const version = localVersion();
  const head = await git(['rev-parse', '--short', 'HEAD']);
  await git(['fetch', '--quiet', 'origin', 'main'], 60_000); // offline → stale info, fine
  const behind = parseInt((await git(['rev-list', '--count', 'HEAD..origin/main'])) || '0', 10) || 0;
  let remoteVersion = null;
  if (behind > 0) {
    try {
      remoteVersion = JSON.parse(await git(['show', 'origin/main:package.json'])).version;
    } catch {}
  }
  // Being commits-behind isn't enough: a dev clone mid-release can trail
  // origin/main by a merge commit while already carrying a NEWER version —
  // offering "v0.3.2 available" on a v0.4.0 board is noise, not an update.
  const updateAvailable = behind > 0 && (remoteVersion ? newer(remoteVersion, version) : true);
  cache = { at: Date.now(), data: { version, head, behind, remoteVersion, updateAvailable } };
  return cache.data;
}

function normalizeNewlines(s) {
  return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parsePkg(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutVersion(pkg) {
  const copy = { ...pkg };
  delete copy.version;
  return copy;
}

// True when the worktree package.json carries nothing origin/main lacks:
// the same JSON, a formatter rewrite of HEAD, or a version field origin has
// already passed (the bump every release writes) with no other edits.
function disposablePackageJson(head, local, origin) {
  const H = parsePkg(head);
  const L = parsePkg(local);
  const O = parsePkg(origin);
  if (!H || !L || !O) return false;
  if (stable(L) === stable(O) || stable(L) === stable(H)) return true;
  if (typeof L.version !== 'string' || typeof O.version !== 'string' || typeof H.version !== 'string') return false;
  // Ahead of origin: an in-progress bump the update must not throw away.
  if (newer(L.version, O.version)) return false;
  const restMatchesOrigin = stable(withoutVersion(L)) === stable(withoutVersion(O));
  const restMatchesHead = stable(withoutVersion(L)) === stable(withoutVersion(H));
  if (!restMatchesOrigin && !restMatchesHead) return false;
  // A downgrade relative to the commit we're on is an edit. A forward bump
  // (or the committed version) that origin has already passed is bookkeeping.
  if (newer(H.version, L.version)) return false;
  return true;
}

function lineCounts(text) {
  const counts = new Map();
  for (const line of normalizeNewlines(text).split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) continue;
    counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
  }
  return counts;
}

function diffCounts(fromText, toText) {
  const from = lineCounts(fromText);
  const to = lineCounts(toText);
  const added = new Map();
  const removed = new Map();
  for (const key of new Set([...from.keys(), ...to.keys()])) {
    const delta = (to.get(key) || 0) - (from.get(key) || 0);
    if (delta > 0) added.set(key, delta);
    else if (delta < 0) removed.set(key, -delta);
  }
  return { added, removed };
}

function countsCover(part, whole) {
  for (const [key, n] of part) {
    if ((whole.get(key) || 0) < n) return false;
  }
  return true;
}

// True when every non-blank changelog line the worktree added or removed
// relative to HEAD is already in origin/main's diff. Blank-line noise (a
// formatter, or an empty Unreleased gap) does not count. A private bullet
// origin lacks does.
function disposableChangelog(head, local, origin) {
  const localNorm = normalizeNewlines(local);
  if (localNorm === normalizeNewlines(origin) || localNorm === normalizeNewlines(head)) return true;
  const localDiff = diffCounts(head, local);
  const originDiff = diffCounts(head, origin);
  return countsCover(localDiff.added, originDiff.added)
    && countsCover(localDiff.removed, originDiff.removed);
}

function disposableVersionFile(file, head, local, origin) {
  const base = String(file).replace(/\\/g, '/');
  if (base === 'package.json') return disposablePackageJson(head, local, origin);
  if (base === 'CHANGELOG.md') return disposableChangelog(head, local, origin);
  return false;
}

function parsePorcelain(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ').pop();
    let kind = 'other';
    if (code === '??') kind = 'untracked';
    else if (code.includes('D')) kind = 'delete';
    else if (code.includes('R') || code.includes('C')) kind = 'rename';
    else if (code.includes('M')) kind = 'modify';
    entries.push({ path: file.replace(/\\/g, '/'), kind });
  }
  return entries;
}

// Paths to restore to HEAD before the fast-forward, or a block when any
// overlapping dirt is real work. Never restores a subset: one real edit
// means the worktree is left exactly as we found it.
async function restorableVersionFiles(root) {
  const fetched = await gitAt(root, ['fetch', '--quiet', 'origin', 'main'], { timeout: 60_000 });
  if (!fetched.ok) return { error: fetched.err || 'fetch failed' };

  // Diverged or ahead: leave the worktree alone. merge --ff-only reports it.
  const ancestor = await gitAt(root, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
  if (!ancestor.ok) return { restore: [] };

  const incoming = await gitAt(root, ['diff', '--name-only', 'HEAD', 'origin/main']);
  if (!incoming.ok) return { error: incoming.err || 'could not diff origin/main' };
  const incomingSet = new Set(incoming.out.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/')));

  // Keep the leading status column. Trimming the buffer would turn
  // " M package.json" into "M package.json" and mis-read the path.
  const status = await gitAt(root, ['status', '--porcelain', '--untracked-files=all'], { trim: false });
  if (!status.ok) return { error: status.err || 'could not read git status' };

  const restore = [];
  for (const entry of parsePorcelain(status.out)) {
    if (!incomingSet.has(entry.path)) continue;
    if (entry.kind !== 'modify' || !VERSION_FILES.includes(entry.path)) {
      return { restore: [], blocked: entry.path };
    }
    const head = await gitAt(root, ['show', `HEAD:${entry.path}`], { trim: false });
    const origin = await gitAt(root, ['show', `origin/main:${entry.path}`], { trim: false });
    const index = await gitAt(root, ['show', `:${entry.path}`], { trim: false });
    if (!head.ok || !origin.ok || !index.ok) return { restore: [], blocked: entry.path };
    let worktree;
    try {
      worktree = fs.readFileSync(path.join(root, entry.path), 'utf8');
    } catch {
      return { restore: [], blocked: entry.path };
    }
    const indexOk = disposableVersionFile(entry.path, head.out, index.out, origin.out);
    const workOk = disposableVersionFile(entry.path, head.out, worktree, origin.out);
    if (!indexOk || !workOk) return { restore: [], blocked: entry.path };
    restore.push(entry.path);
  }
  return { restore };
}

// Fast-forward to origin/main; npm ci when the lockfile moved. The caller
// restarts the process afterwards (under launchd, exiting IS restarting).
// Fetch + merge name origin/main explicitly: the current branch's upstream
// may be gone (e.g. a merged-and-deleted PR branch), which broke a bare
// `git pull`. opts.root / opts.runNpm exist so tests can point at a fixture
// repo and skip npm ci.
function update(opts = {}) {
  const root = opts.root || ROOT;
  const runNpm = opts.runNpm !== false;
  return (async () => {
    const prep = await restorableVersionFiles(root);
    if (prep.error) throw new Error(String(prep.error).slice(0, 300));
    if (prep.restore.length) {
      const cleared = await gitAt(root, ['checkout', 'HEAD', '--', ...prep.restore]);
      if (!cleared.ok) throw new Error((cleared.err || 'could not clear version files').slice(0, 300));
    }
    const merged = await gitAt(root, ['merge', '--ff-only', 'origin/main'], { timeout: 120_000 });
    if (!merged.ok) throw new Error(String(merged.err || merged.out || 'update failed').trim().slice(0, 300));
    if (root === ROOT) cache = { at: 0, data: null };
    if (runNpm && /package-lock\.json/.test(merged.out)) {
      await new Promise((resolve, reject) => {
        execFile('npm', ['ci'], { cwd: root, timeout: 300_000 }, (e) =>
          e ? reject(new Error('pulled, but npm ci failed — run it manually')) : resolve());
      });
    }
    return { output: merged.out.trim().split('\n').pop() };
  })();
}

module.exports = { check, update, newer, disposableVersionFile };
