// Desktop + push notifications for board events.
// macOS notification via osascript; optional ntfy.sh push for remote access.
const { execFile } = require('child_process');
const { state } = require('./store');

function macNotify(title, body) {
  if (state.settings.notifyMac === false) return;
  if (process.platform !== 'darwin') return;
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`;
  execFile('osascript', ['-e', script], () => {});
}

// ntfy topics are [A-Za-z0-9_-]; anything else is either unset or a topic the
// human disabled by editing it (prefixing it is the usual trick). Posting one
// anyway just earns an HTTP 400 per notification — thousands of them in the
// server log — so treat "not a valid topic" as "push is off".
function validTopic(topic) {
  return /^[A-Za-z0-9_-]{1,64}$/.test((topic || '').trim());
}

function ntfyPush(title, body, url) {
  const topic = (state.settings.ntfyTopic || '').trim();
  if (!validTopic(topic)) return;
  // JSON publish endpoint: title/message ride in the body, so UTF-8 (em dashes,
  // emoji in card titles) is safe — HTTP headers only allow Latin-1.
  const msg = { topic, title, message: body, tags: ['martial_arts_uniform'] };
  if (url) msg.click = url;
  fetch('https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  }).then((res) => {
    if (!res.ok) console.error(`ntfy push failed: HTTP ${res.status}`);
  }).catch((e) => console.error('ntfy push failed:', e.cause?.message || e.message));
}

// Fire-and-forget on both channels.
function notify(title, body, url = null) {
  macNotify(title, body);
  ntfyPush(title, body, url);
}

module.exports = { notify, validTopic };
