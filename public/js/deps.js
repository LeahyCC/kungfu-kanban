/* Dependency logic — mirrors lib/deps.js's unmet()/prUnshipped(); keep in sync.
 * Used by both board.js (badges, sort) and drawer.js (renderDrawerMeta). */

import { state } from './state.js';

// The dep cards that still block this one (deleted/archived ids count as met —
// same rule as the server). A done card whose PR is still open unmerged also
// blocks — its code hasn't reached the default branch yet.
export function depsUnmet(t) {
  return (t.deps || [])
    .map((id) => state.tasks.find((x) => x.id === id))
    .filter((d) => d && (d.status !== 'done' || isPrUnshipped(d)));
}

// Done, but its PR is still open unmerged — the code hasn't reached the
// default branch, so it still blocks any card that depends on it.
export function isPrUnshipped(t) {
  return t.status === 'done' && t.openPr && t.prUrl && !t.prMergedAt && !t.prClosedNoted;
}

// How many unmet prerequisites stack under this card. Sorting a column by it
// (then priority) lays every dependency chain out in the order it will run;
// unrelated cards are all depth 0 and keep pure priority order, and a shipped
// prerequisite drops its dependents back to depth 0.
export function chainDepth(t, seen = new Set()) {
  if (seen.has(t.id)) return 0; // cycle guard
  seen.add(t.id);
  let d = 0;
  for (const dep of depsUnmet(t)) d = Math.max(d, 1 + chainDepth(dep, seen));
  return d;
}

// Per-render-pass dependency context. One id→task index plus memoized
// depsUnmet/chainDepth, a precomputed "who waits on this id" map, and group
// rollups — together they kill the old O(n²) hotspots (find-per-dep,
// chainDepth inside the sort comparator, per-card filters of the whole task
// list for the "blocks N" badge and the group done/total counts).
export function depPass(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const unmetMemo = new Map();
  const unmet = (t) => {
    let u = unmetMemo.get(t.id);
    if (!u) {
      u = (t.deps || [])
        .map((id) => byId.get(id))
        .filter((d) => d && (d.status !== 'done' || isPrUnshipped(d)));
      unmetMemo.set(t.id, u);
    }
    return u;
  };

  const depthMemo = new Map();
  const depth = (t, seen = new Set()) => {
    const cached = depthMemo.get(t.id);
    if (cached !== undefined) return cached;
    if (seen.has(t.id)) return 0; // cycle guard
    seen.add(t.id);
    let d = 0;
    for (const dep of unmet(t)) d = Math.max(d, 1 + depth(dep, seen));
    depthMemo.set(t.id, d);
    return d;
  };

  // "🖐 blocks N": queued cards waiting on each id (holders listed so the
  // badge tooltip can name them without another scan).
  const heldMap = new Map();
  for (const t of tasks) {
    if (t.status !== 'queued') continue;
    for (const id of (t.deps || [])) {
      const list = heldMap.get(id);
      if (list) list.push(t); else heldMap.set(id, [t]);
    }
  }
  const held = (id) => heldMap.get(id) || [];

  // Group rollup across ALL columns (a group's cards can be spread out).
  const groupStats = new Map();
  for (const t of tasks) {
    if (!t.group) continue;
    let s = groupStats.get(t.group);
    if (!s) { s = { total: 0, done: 0 }; groupStats.set(t.group, s); }
    s.total++;
    if (t.status === 'done') s.done++;
  }

  return { byId, unmet, depth, held, groupStats };
}
