// Subscription-limit cooldown. When a run dies on a usage/rate limit, the
// board pauses all auto flow (queue pumping, manager triggers, PR auto-fix)
// until the limit resets, requeues the victim card, and shows a countdown in
// the header. Reset time is parsed from the CLI's error message when possible;
// otherwise we back off for an hour.
const { state, save } = require('./store');
const { notify } = require('./notify');

let broadcast = () => {};
let timer = null;

function setBroadcaster(fn) {
  broadcast = fn;
  arm(); // resume a persisted cooldown after a server restart
}

function until() {
  return state.settings.cooldownUntil || 0;
}

function active() {
  return until() > Date.now();
}

// Is this error a subscription/usage limit (vs a normal task failure)?
// Covers the CLI's newer "You've hit your session limit · resets 11:30pm"
// phrasing as well as the older "usage limit reached" wording.
function detect(text) {
  return /usage limit|rate.?limit|session limit|hit your [\w ]*limit|limit (?:reached|hit|will reset)|too many requests|out of extended usage/i.test(text || '');
}

// "resets at 3pm", "resets 10:30", or a unix epoch buried in the message.
function parseReset(msg) {
  const ep = (msg || '').match(/\b(1[6-9]\d{8})\b/);
  if (ep) {
    const t = parseInt(ep[1], 10) * 1000;
    if (t > Date.now() && t < Date.now() + 8 * 86400_000) return t;
  }
  const m = (msg || '').match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return Date.now() + 60 * 60_000;
}

function hit(msg) {
  const t = parseReset(msg);
  if (t <= until()) return; // already cooling at least that long
  state.settings.cooldownUntil = t;
  state.settings.cooldownReason = (msg || '').replace(/\s+/g, ' ').slice(0, 200);
  save();
  broadcast({ type: 'cooldown', until: t });
  notify(
    'Kungfu Kanban — subscription limits hit',
    `Auto flow paused until ${new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  );
  arm();
}

function clear() {
  state.settings.cooldownUntil = 0;
  save();
  broadcast({ type: 'cooldown', until: 0 });
  arm();
}

function arm() {
  clearTimeout(timer);
  const ms = until() - Date.now();
  if (ms <= 0) return;
  // This timer is the only thing that resumes a parked queue, and it can't
  // fire on a sleeping Mac — hold a timed assertion across the cooldown
  // whenever cards are waiting on it (also re-armed here on server boot).
  if (state.tasks.some((t) => t.status === 'queued')) {
    require('./awake').holdUntil(until() + 60_000);
  }
  timer = setTimeout(() => {
    broadcast({ type: 'cooldown', until: 0 });
    notify('Kungfu Kanban — limits reset', 'Training resumes; queued cards are launching.');
    require('./runner').pumpQueue(); // lazy: avoids a require cycle
  }, ms + 2000);
}

module.exports = { setBroadcaster, active, until, detect, hit, clear };
