// Keeps the Mac awake while the board is working, via caffeinate power
// assertions (-i idle sleep, -m disk sleep, -s system sleep on AC). Two
// mechanisms:
//
//   hold(pid)     — per-agent: `caffeinate -w <pid>` lasts exactly as long as
//                   that process, even across a server restart (detached), so
//                   nothing can leak a permanently-awake machine.
//   holdUntil(ts) — one shared timed assertion (`caffeinate -t`) bridging the
//                   windows where no agent is alive but sleep would still
//                   stall the board: post-run finalize (PR push, Sensei
//                   handoff) and a subscription cooldown with queued cards
//                   (the reset timer can't fire on a sleeping Mac). Only ever
//                   extended, never shortened; dies with the server — boot
//                   re-arms it via cooldown.arm() — or via clear().
//
// The display is still allowed to turn off; only system sleep stalls tasks.
// Everything is a no-op off macOS, when the "keep Mac awake" setting is off,
// or when the caffeinate binary is missing.
const { spawn } = require('child_process');
const { state } = require('./store');

function enabled() {
  return process.platform === 'darwin' && state.settings.keepAwake !== false;
}

function launch(args, opts) {
  try {
    const c = spawn('caffeinate', args, { stdio: 'ignore', ...opts });
    c.on('error', () => {}); // no caffeinate binary — silently skip
    return c;
  } catch {
    return null;
  }
}

function hold(pid) {
  if (!enabled()) return;
  if (!Number.isInteger(pid) || pid <= 0) return; // spawn failed → no pid
  const c = launch(['-i', '-m', '-s', '-w', String(pid)], { detached: true });
  if (c) c.unref();
}

let bridge = null; // { proc, until } — the single timed assertion

function holdUntil(ts) {
  if (!enabled()) return;
  const secs = Math.ceil((ts - Date.now()) / 1000);
  if (secs <= 0) return;
  if (bridge && bridge.until >= ts && bridge.proc.exitCode === null) return; // already covered
  clear();
  const proc = launch(['-i', '-m', '-s', '-t', String(secs)]);
  if (proc) bridge = { proc, until: ts };
}

function clear() {
  if (!bridge) return;
  try { bridge.proc.kill(); } catch {}
  bridge = null;
}

module.exports = { hold, holdUntil, clear };
