// Lost-internet guard. When a run dies on a connectivity error (Wi-Fi down,
// DNS dead, api.anthropic.com unreachable), the board pauses auto flow,
// requeues the victim card, and probes every 30s until the connection is
// back — then resumes the queue. In-memory only: after a server restart the
// first failed launch re-trips it.
const dns = require('dns');
const { broadcast } = require('./bus');

let offline = false;
let timer = null;

function active() {
  return offline;
}

// Does this error read like lost connectivity (vs a normal task failure)?
// Matches the Claude CLI's connection failures and Node's socket error codes.
// Always confirmed by an actual probe() before acting — a card whose own work
// mentions ECONNREFUSED (a dead localhost server, say) must not trip this.
function detect(text) {
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|getaddrinfo|fetch failed|network error|connection (?:error|failed|refused|reset|timed out)|socket hang up|unable to connect|no internet/i.test(text || '');
}

// True when the internet really is unreachable right now. DNS to the API host
// races a 5s timeout — an unanswered resolver counts as down.
function probe() {
  return Promise.race([
    dns.promises.lookup('api.anthropic.com').then(() => false, () => true),
    new Promise((r) => setTimeout(() => r(true), 5000)),
  ]);
}

function recheck() {
  probe().then((down) => {
    if (down) timer = setTimeout(recheck, 30_000);
    else clear();
  });
}

function hit(msg) {
  if (offline) return;
  offline = true;
  require('./errlog').capture('offline', {
    text: 'internet connection lost — auto flow paused; queued cards relaunch when it returns',
    detail: (msg || '').replace(/\s+/g, ' ').slice(0, 300),
  });
  broadcast({ type: 'offline', offline: true });
  // ponytail: no wake assertion here — an outage is open-ended; a sleeping
  // Mac just rechecks on wake.
  timer = setTimeout(recheck, 30_000);
}

function clear() {
  if (!offline) return;
  offline = false;
  clearTimeout(timer);
  broadcast({ type: 'offline', offline: false });
  require('./errlog').resolveKind('offline');
  require('./notify').notify('Kungfu Kanban — back online', 'Internet restored; queued cards are launching.');
  require('./runner').pumpQueue(); // lazy: avoids a require cycle
}

module.exports = { active, detect, probe, hit, clear };
