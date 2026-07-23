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
// ponytail: recomputed per card per render — memoize if boards get huge.
export function chainDepth(t, seen = new Set()) {
  if (seen.has(t.id)) return 0; // cycle guard
  seen.add(t.id);
  let d = 0;
  for (const dep of depsUnmet(t)) d = Math.max(d, 1 + chainDepth(dep, seen));
  return d;
}
