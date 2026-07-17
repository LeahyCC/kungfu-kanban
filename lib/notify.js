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

function ntfyPush(title, body, url) {
  const topic = (state.settings.ntfyTopic || '').trim();
  if (!topic) return;
  const headers = { Title: title, Priority: 'default', Tags: 'martial_arts_uniform' };
  if (url) headers.Click = url;
  fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body,
  }).catch(() => {});
}

// Fire-and-forget on both channels.
function notify(title, body, url = null) {
  macNotify(title, body);
  ntfyPush(title, body, url);
}

module.exports = { notify };
