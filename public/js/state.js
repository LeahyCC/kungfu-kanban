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
};
