// Card dependencies. A card's `deps` is an array of task ids that must all be
// "done" before the runner will launch it — queued dependents wait in Queued
// and start automatically when the last prerequisite ships (approve, PR merge,
// or a human drag to Done). A dep id that no longer resolves (deleted or
// archived card) counts as satisfied so a cleanup can never wedge the queue.
const { state, getTask } = require('./store');

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
function unmet(task) {
  const out = [];
  for (const id of task.deps || []) {
    const dep = getTask(id);
    if (dep && (dep.status !== 'done' || prUnshipped(dep))) out.push(dep);
  }
  return out;
}

function ready(task) {
  return unmet(task).length === 0;
}

// The queued/backlog cards whose deps include `id` — the work this card holds
// up. Drives the "🖐 blocks N" bottleneck surfacing.
function dependentsOf(id) {
  return state.tasks.filter(
    (t) => (t.deps || []).includes(id) && (t.status === 'queued' || t.status === 'backlog')
  );
}

// Would setting `deps` on task `id` close a cycle? Walks the existing graph
// from each proposed dep looking for a path back to `id`.
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

module.exports = { sanitize, unmet, ready, dependentsOf, wouldCycle, prUnshipped };
