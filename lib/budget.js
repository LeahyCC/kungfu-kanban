// Self-imposed 5-hour token-budget guard, shaped like offline.js: an
// in-memory flag consulted by pumpQueue/startTask/manager, self-clearing as
// the rolling window slides. Data source is usage.scan() (2-min cache); the
// 60s pump sweep in server.js re-calls active(), so trips and clears land
// within a minute or two of fresh data. Metric is output tokens vs
// settings.usageBudgetTokens — the same formula as the ⛽ chip.
const { state } = require('./store');
const { broadcast } = require('./bus');

let over = false;
let checking = false;

function budget() {
  return state.settings.usageBudgetTokens || 0;
}

// Pure decision — the unit-testable core.
function isOver(outputTokens, budgetTokens) {
  return budgetTokens > 0 && (outputTokens || 0) >= budgetTokens;
}

// Sync gate: answers from the last scan, kicks a background refresh.
function active() {
  refresh();
  return over;
}

function refresh() {
  if (!budget()) {
    if (over) clear();
    return;
  }
  if (checking) return;
  checking = true;
  require('./usage').scan()
    .then((u) => {
      const next = isOver(u.output, budget());
      if (next && !over) hit(u.output);
      else if (!next && over) clear();
    })
    .catch(() => {})
    .finally(() => {
      checking = false;
    });
}

function hit(outputTokens) {
  over = true;
  require('./errlog').capture('budget', {
    text: '5-hour usage budget spent — auto launches paused until the window slides',
    detail: `${outputTokens} output tokens ≥ ${budget()} budget`,
  });
  broadcast({ type: 'usage', blocked: true });
  // ponytail: no wake assertion here — the clear time is open-ended; a
  // sleeping Mac just rechecks on wake (offline.js precedent).
  require('./notify').notify('Kungfu Kanban — usage budget spent',
    'Auto flow paused; queued cards launch as the 5-hour window slides.');
}

function clear() {
  over = false;
  broadcast({ type: 'usage', blocked: false });
  require('./errlog').resolveKind('budget');
  require('./notify').notify('Kungfu Kanban — budget freed', 'Queued cards are launching.');
  require('./runner').pumpQueue(); // lazy: avoids a require cycle
}

module.exports = { active, isOver, hit, clear };
