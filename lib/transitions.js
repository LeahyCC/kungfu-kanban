// The one place a card's status changes. Every writer (runner, manager, PR
// flow, PR watcher, the PATCH route, the boot sweep) goes through setStatus so
// the flow facts below are stamped the same way no matter who moved the card.
// Deliberately free of store/runner imports: store.js uses it at boot, and a
// require cycle there would hand it a half-built module.
//
// Facts recorded on the card (old cards simply lack them):
//   queuedAt  ISO time of the latest entry into `queued`
//   doneAt    ISO time of the latest entry into `done`
//   sendBacks how many times a card that had left the working lanes was put
//             back to work (see below)
//
// A send-back is a card in `review` or `done` that moves to `queued` or
// `running` instead of being finished: the Sensei's reject_task and
// requeue_task, a human dragging it back, a plain re-run. Cards leaving
// `running`/`stopping` or `backlog` are first runs, cooldown re-parks and
// stop/finish handling, not send-backs. A follow-up is counted separately in
// `followUps`, and the runner's own re-parks (cooldown, offline, model fallback,
// logged-out CLI) are the board's doing, not a verdict on the work, so those
// moves pass { sendBack: false }. Setting the status a card already has changes nothing, which keeps
// queuedAt/doneAt at the real event (the PR watcher re-asserts `done` on a
// card a human already approved, and that must not reset the clock).
const BACK_FROM = new Set(['review', 'done']);
const BACK_TO = new Set(['queued', 'running']);

function setStatus(task, next, opts = {}) {
  const prev = task.status;
  if (prev === next) return task;
  const now = new Date().toISOString();
  if (next === 'queued') task.queuedAt = now;
  if (next === 'done') task.doneAt = now;
  if (opts.sendBack !== false && BACK_FROM.has(prev) && BACK_TO.has(next)) {
    task.sendBacks = (task.sendBacks || 0) + 1;
  }
  task.status = next;
  return task;
}

function countFollowUp(task) {
  task.followUps = (task.followUps || 0) + 1;
  return task;
}

module.exports = { setStatus, countFollowUp };
