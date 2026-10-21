// Card dependencies. A card's `deps` is an array of task ids that must all be
// "done" before the runner will launch it — queued dependents wait in Queued
// and start automatically when the last prerequisite ships (approve, PR merge,
// or a human drag to Done). A dep id that no longer resolves (deleted or
// archived card) counts as satisfied so a cleanup can never wedge the queue.
//
// A card may also wait on contracts (`uses`, see lib/contracts.js): entries
// { name, version } where a null version means any version. These are weaker
// than deps: they wait for a published file to exist, not for code to merge.
const { state, getTask } = require('./store');
const contracts = require('./contracts');

const MAX_USES = 20;

// Normalize a deps value from any writer (importer, manager, API): strings
// only, deduped, never self-referential.
function sanitize(deps, selfId) {
  if (!Array.isArray(deps)) return [];
  const out = [];
  for (const d of deps) {
    const id = String(d || '').trim();
    if (!id || id === selfId || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

// A done card whose PR is still open unmerged hasn't actually shipped its
// code to the default branch yet — a dependent worktree card would base off
// main without it. A done card that never opened a PR, or whose PR closed
// without merging, releases as usual (the human's done verdict stands).
function prUnshipped(dep) {
  return dep.status === 'done' && dep.openPr && dep.prUrl && !dep.prMergedAt && !dep.prClosedNoted;
}

// The dep tasks that still block this card (unresolvable ids are satisfied).
// Mirrored client-side by public/js/deps.js's depsUnmet()/isPrUnshipped() — keep both in sync.
function unmet(task) {
  const out = [];
  for (const id of task.deps || []) {
    const dep = getTask(id);
    if (dep && (dep.status !== 'done' || prUnshipped(dep))) out.push(dep);
  }
  return out;
}

function versionOf(v) {
  if (!/^[1-9][0-9]{0,8}$/.test(String(v))) throw new Error('version must be an integer >= 1');
  return Number(v);
}

// "<name>" or "<name>@<version>" (the importer's uses: line) → one entry.
// Throws Error with a message fit for an import warning or a 400.
function parseUse(value) {
  const m = String(value).trim().match(/^([^@\s]+)(?:@(\S+))?$/);
  if (!m) throw new Error('expected "<contract-name>" or "<contract-name>@<version>"');
  contracts.validName(m[1]);
  return { name: m[1], version: m[2] === undefined ? null : versionOf(m[2]) };
}

// API input → [{ name, version }], deduped. Entries may be importer-style
// strings or { name, version } objects. Throws on the first bad entry.
function normalizeUses(list) {
  if (!Array.isArray(list)) throw new Error('uses must be an array');
  if (list.length > MAX_USES) throw new Error(`uses is limited to ${MAX_USES} entries`);
  const out = [];
  for (const e of list) {
    let entry;
    if (typeof e === 'string') {
      entry = parseUse(e);
    } else if (e && typeof e === 'object') {
      contracts.validName(e.name);
      entry = { name: e.name, version: e.version === undefined || e.version === null ? null : versionOf(e.version) };
    } else {
      throw new Error('each uses entry must be "<name>[@<version>]" or { name, version }');
    }
    if (!out.some((x) => x.name === entry.name && x.version === entry.version)) out.push(entry);
  }
  return out;
}

// name → newest version. Versions run 1..n with no gaps and are never deleted,
// so "version v exists" is "newest >= v". An unreadable index reads as no
// contracts: the card waits, which beats launching it without its input.
function latestVersions() {
  try {
    return new Map(contracts.list().map((c) => [c.name, c.version]));
  } catch {
    return new Map();
  }
}

// The uses entries this card still waits on: an unpinned one needs any version
// of its name, a pinned one needs that exact version. A contract never goes
// away, so once met an entry stays met.
// Mirrored client-side by public/js/deps.js's usesUnmet() — keep both in sync.
function unmetUses(task, latest) {
  const uses = Array.isArray(task.uses) ? task.uses : [];
  if (!uses.length) return [];
  const have = latest || latestVersions();
  return uses.filter((u) => (have.get(u.name) || 0) < (u.version || 1));
}

// What a launching card gets for its `uses`: unpinned means the latest version
// right now, pinned means exactly that version. Throws if one cannot be read
// (readiness checked it, so this is a corrupt or removed store); the caller
// fails the launch rather than starting an agent without its input.
function resolveUses(task) {
  const uses = Array.isArray(task.uses) ? task.uses : [];
  return uses.map((u) => {
    try {
      const { contract, content } = contracts.get(u.name, u.version === null ? undefined : u.version);
      return { name: contract.name, version: contract.version, sha256: contract.sha256, content };
    } catch (e) {
      const pin = u.version ? `@${u.version}` : '';
      throw new Error(`contract ${u.name}${pin} could not be read at launch: ${e.message}`);
    }
  });
}

function ready(task) {
  return unmet(task).length === 0 && unmetUses(task).length === 0;
}

// The queued/backlog cards whose deps include `id` — the work this card holds
// up. Drives the "🖐 blocks N" bottleneck surfacing.
function dependentsOf(id) {
  return state.tasks.filter(
    (t) => (t.deps || []).includes(id) && (t.status === 'queued' || t.status === 'backlog')
  );
}

// Would setting `deps` on task `id` close a cycle? Walks the existing graph
// from each proposed dep looking for a path back to `id`. `uses` entries add
// no edges: they name contracts, not cards, so they cannot close a cycle.
function wouldCycle(id, deps) {
  const seen = new Set();
  const stack = [...(deps || [])];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === id) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = getTask(cur);
    for (const next of (t && t.deps) || []) stack.push(next);
  }
  return false;
}

module.exports = {
  sanitize, unmet, ready, dependentsOf, wouldCycle, prUnshipped, parseUse, normalizeUses, unmetUses, latestVersions, resolveUses,
};
