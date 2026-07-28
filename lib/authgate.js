// Logged-out-CLI guard, shaped like offline.js: when a run dies on "Not
// logged in", AUTO flow (queue pump + Sensei triggers) pauses behind one
// deduped ⚠ entry instead of spamming the log on every trigger. There is no
// cheap probe for auth, so every HUMAN-initiated run stays ungated and acts
// as the probe: the Run button (startTask), a drawer follow-up (followUp),
// and Sensei chat all still launch, and any success clears the gate. The 🔐
// chip keeps the paused state visible. In-memory only: after a restart the
// first failed launch re-trips it.
const { broadcast } = require('./bus');

let blocked = false;

function active() {
  return blocked;
}

// Does this error read like a logged-out CLI (vs a normal task failure)?
function detect(text) {
  return /not logged in|please run \/login|invalid api key|authentication[_ ]error|oauth token (?:expired|revoked|invalid)|401 unauthorized/i.test(text || '');
}

function hit(msg) {
  if (blocked) return;
  blocked = true;
  require('./errlog').capture('auth', {
    text: 'Claude CLI is not logged in — auto flow paused; run `claude /login` in a terminal, then any successful run resumes the board',
    detail: (msg || '').replace(/\s+/g, ' ').slice(0, 300),
  });
  broadcast({ type: 'auth', blocked: true });
  require('./notify').notify('Kungfu Kanban — Claude CLI logged out',
    'Run `claude /login`, then launch any card to resume auto flow.');
}

function clear() {
  if (!blocked) return;
  blocked = false;
  broadcast({ type: 'auth', blocked: false });
  require('./errlog').resolveKind('auth');
  require('./runner').pumpQueue(); // lazy: avoids a require cycle
}

module.exports = { active, detect, hit, clear };
