/* Kungfu Kanban frontend — shared state + board-shape constants.
 *
 * The four cross-module mutables live on one exported `state` object rather
 * than as `export let` bindings: ES modules forbid an importer reassigning an
 * imported binding, and the SSE dispatcher does `state.tasks = state.tasks
 * .filter(...)`. Every module reads/writes `state.tasks`/`state.config`/etc.
 * through this single shared object reference. Section-private state stays in
 * its owning module. */

export const COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'queued', label: 'Queued' },
  { key: 'running', label: 'Running' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];
// statuses that render inside the "running" column
export const RUNNING_LIKE = { running: 1, stopping: 1 };

// Context-window size the ctx % is measured against. All current Claude Code
// models ship a 200k window; adjust here if that changes.
export const CTX_WINDOW = 200_000;

export const state = {
  config: { models: [], efforts: [], permissionModes: [], skills: [], agents: [], settings: {} },
  tasks: [],
  editingId: null,
  drawerId: null,
  mgrState: null,
  // Last known board version (max task.v seen over SSE, or X-Board-Version
  // from a conditional GET). 0 = version support not yet detected — loadTasks
  // then does a plain full fetch, exactly like before.
  boardV: 0,
};

// Optimistic-mutation registry. While a PATCH/POST is in flight, an SSE echo
// carrying the PRE-mutation revision must not clobber the optimistic local
// state. Only meaningful when the server stamps task.v; with v absent every
// event applies (today's eventual-consistency behavior). base records the v
// stamped BEFORE the optimistic mutation; an echo with v <= base is stale.
export const optimistic = {
  base: new Map(), // taskId → pre-mutation v
  note(id, task) {
    if (task && task.v !== undefined && !this.base.has(id)) this.base.set(id, task.v);
  },
  isStaleEcho(id, v) {
    if (v === undefined) return false; // no version support → keep today's behavior
    const b = this.base.get(id);
    return b !== undefined && v <= b;
  },
  clear(id) { this.base.delete(id); },
};

// Slim SSE projections omit the heavy text fields (prompt, resultText,
// acceptanceCriteria) and carry full:false — merge those shallowly over the
// cached task so the omitted fields survive. Full payloads (no flag, e.g. the
// current un-slimmed server) replace wholesale, matching the old behavior.
export function mergeTaskPayload(existing, incoming) {
  if (!existing || incoming.full !== false) return incoming;
  return { ...existing, ...incoming };
}
