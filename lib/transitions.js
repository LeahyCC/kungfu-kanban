// The one place a card's status changes. Every writer (runner, manager, PR
// flow, PR watcher, the PATCH route, the boot sweep) goes through setStatus so
// the flow facts below are stamped the same way no matter who moved the card.
// Deliberately free of store/runner imports: store.js uses it at boot, and a
// require cycle there would hand it a half-built module.
//
// Facts recorded on the card (old cards simply lack them):
//   firstQueuedAt  ISO time of the first entry into `queued`, never overwritten
//   firstStartedAt ISO time of the first entry into `running`, never overwritten
//   queuedAt       ISO time of the latest entry into `queued` (information only)
//   doneAt         ISO time a person or the Sensei last marked the card done
//   sendBacks      how many times a card that had left the working lanes was put
//                  back to work (see below)
//
// The flow report's queued wait is firstStartedAt - firstQueuedAt: how long a
// card sat before any work began. queuedAt can't carry that, because every
// later lap and re-park would move it.
//
// A send-back is a card in `review` or `done` that moves to `queued` or
// `running` instead of being finished: the Sensei's reject_task and
// requeue_task, a human dragging it back, a plain re-run. Cards leaving
// `running`/`stopping` or `backlog` are first runs, cooldown re-parks and
// stop/finish handling, not send-backs. A follow-up is counted separately in
// `followUps`. Options:
//   sendBack: false  skip the send-back count (follow-ups, counted elsewhere)
//   repark: true     the runner's own re-park (cooldown, offline, model
//                    fallback, logged-out CLI). Not a verdict on the work, so
//                    no send-back, and queuedAt keeps the time the human or
//                    Sensei last queued the card instead of the moment the
//                    board parked it.
//   merged: true     the PR merging is what moved the card to done, not a
//                    person or the Sensei approving it, so doneAt is not
//                    stamped (and an earlier lap's doneAt is dropped). Done to
//                    merged then only measures cards approved before they
//                    merged.
// Setting the status a card already has changes nothing, which keeps
// queuedAt/doneAt at the real event (the PR watcher re-asserts `done` on a
// card a human already approved, and that must not reset the clock).
const BACK_FROM = new Set(['review', 'done']);
const BACK_TO = new Set(['queued', 'running']);

function setStatus(task, next, opts = {}) {
  const prev = task.status;
  if (prev === next) return task;
  const now = new Date().toISOString();
  if (next === 'queued') {
    if (!task.firstQueuedAt) task.firstQueuedAt = now;
    if (!opts.repark) task.queuedAt = now;
  }
  if (next === 'running' && !task.firstStartedAt) task.firstStartedAt = now;
  if (next === 'done') {
    if (opts.merged) delete task.doneAt;
    else task.doneAt = now;
  }
  if (opts.sendBack !== false && !opts.repark && BACK_FROM.has(prev) && BACK_TO.has(next)) {
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
