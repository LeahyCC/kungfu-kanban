// Terminal sessions for the board's built-in terminal.
//
// Each session is a login+interactive shell on a real pty (see lib/pty.py), so
// the user's ~/.zshrc, prompt, aliases, and full-screen TUIs work the same as
// in their own terminal. Sessions live on the SERVER, not in the tab: reloading
// the board — or picking the board back up on the phone — reattaches to the
// same shell with its scrollback intact.
//
// Security note: this is a shell on the host, gated by the same token as the
// rest of the API. That is not a new trust boundary — anyone holding the token
// can already POST a card and run it with bypassPermissions — but it is a much
// more direct one, so it can be switched off (settings.terminal === false).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Named ptyhost.py, NOT pty.py: python puts the script's own directory first
// on sys.path, so a file called pty.py shadows the stdlib module it imports.
const HELPER = path.join(__dirname, 'ptyhost.py');
const PYTHON = process.env.KFK_PYTHON || 'python3';

// A phone reattaching mid-build wants context, not the whole build: keep the
// tail. ponytail: flat byte cap, a real scrollback ring if 256KB ever chafes.
const SCROLLBACK_MAX = 256 * 1024;
// A runaway client must not be able to fork-bomb the Mac one POST at a time.
const MAX_SESSIONS = 8;
// A shell nobody is watching still holds a pty and whatever it is running. Keep
// it alive well past a reload or a phone lock, then reap it.
const IDLE_REAP_MS = 30 * 60_000;

const sessions = new Map(); // id -> session

function shellCommand() {
  const shell = process.env.KFK_SHELL || process.env.SHELL || '/bin/zsh';
  // -i sources ~/.zshrc (aliases, starship); -l sources ~/.zprofile, which is
  // where Homebrew's PATH usually lives. Same as a fresh terminal window.
  const args = /(^|\/)(zsh|bash)$/.test(shell) ? ['-il'] : [];
  return { shell, args };
}

function resolveCwd(cwd) {
  const home = os.homedir();
  if (!cwd) return home;
  try {
    return fs.statSync(cwd).isDirectory() ? cwd : home;
  } catch {
    return home;
  }
}

function create({ cwd, cols, rows, label, taskId } = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    return { error: `too many terminals open (${MAX_SESSIONS}) — close one first` };
  }
  const dir = resolveCwd(cwd);
  const { shell, args } = shellCommand();
  const c = Math.max(1, Math.min(2000, parseInt(cols, 10) || 80));
  const r = Math.max(1, Math.min(1000, parseInt(rows, 10) || 24));

  let child;
  try {
    child = spawn(PYTHON, [HELPER, dir, String(c), String(r), shell, ...args], {
      // fd 3 is the control channel the helper reads resize frames from
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { error: `could not start a terminal: ${String(e.message || e).slice(0, 200)}` };
  }

  const s = {
    id: crypto.randomUUID(),
    child,
    cwd: dir,
    // A card's shell belongs to that card: the drawer reattaches to it instead
    // of opening a second one every time you look at the card.
    taskId: taskId || null,
    label: String(label || path.basename(dir) || 'shell').slice(0, 60),
    cols: c,
    rows: r,
    startedAt: Date.now(),
    exited: false,
    exitCode: null,
    buf: Buffer.alloc(0),
    listeners: new Set(),
    reapTimer: null,
  };
  sessions.set(s.id, s);

  child.stdout.on('data', (chunk) => {
    s.buf = Buffer.concat([s.buf, chunk]);
    if (s.buf.length > SCROLLBACK_MAX) s.buf = s.buf.subarray(s.buf.length - SCROLLBACK_MAX);
    for (const fn of s.listeners) fn(chunk);
  });
  // The helper's own stderr is diagnostics (a failed exec, a python traceback);
  // show it in the terminal rather than swallowing it into a dead black box.
  child.stderr.on('data', (chunk) => {
    for (const fn of s.listeners) fn(chunk);
  });
  child.on('exit', (code) => {
    s.exited = true;
    s.exitCode = code;
    const bye = Buffer.from(`\r\n\x1b[38;5;245m[session ended${code ? ` — exit ${code}` : ''}]\x1b[0m\r\n`);
    for (const fn of s.listeners) fn(bye);
    armReap(s, 60_000); // let a reconnecting client read the goodbye, then drop
  });
  child.on('error', (e) => {
    for (const fn of s.listeners) fn(Buffer.from(`\r\n[terminal failed: ${e.message}]\r\n`));
  });
  // A pipe that dies (helper gone) must not take the server with it.
  for (const stream of [child.stdin, child.stdio[3]]) stream.on('error', () => {});

  armReap(s, IDLE_REAP_MS);
  return { session: publicOf(s) };
}

function armReap(s, ms) {
  clearTimeout(s.reapTimer);
  s.reapTimer = setTimeout(() => kill(s.id), ms);
  if (s.reapTimer.unref) s.reapTimer.unref();
}

function publicOf(s) {
  return {
    id: s.id,
    cwd: s.cwd,
    taskId: s.taskId,
    label: s.label,
    cols: s.cols,
    rows: s.rows,
    startedAt: s.startedAt,
    exited: s.exited,
    attached: s.listeners.size,
  };
}

function list() {
  return [...sessions.values()].map(publicOf);
}

function get(id) {
  return sessions.get(id) || null;
}

// The live shell for a card, if it still has one, in the public shape — the
// raw session holds a ChildProcess, which is circular and must never reach
// res.json(). Exited sessions don't count: reopening a card whose shell has
// ended should give you a fresh one, not a dead pane.
function forTask(taskId) {
  if (!taskId) return null;
  for (const s of sessions.values()) {
    if (s.taskId === taskId && !s.exited) return publicOf(s);
  }
  return null;
}

// Attach a client. Returns the scrollback so far plus a detach function; while
// anyone is attached the idle reaper stays disarmed.
function attach(id, onData) {
  const s = sessions.get(id);
  if (!s) return null;
  clearTimeout(s.reapTimer);
  s.reapTimer = null;
  s.listeners.add(onData);
  return {
    backlog: s.buf,
    detach() {
      s.listeners.delete(onData);
      if (!s.listeners.size) armReap(s, s.exited ? 60_000 : IDLE_REAP_MS);
    },
  };
}

function write(id, data) {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  s.child.stdin.write(data);
  return true;
}

function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  s.cols = Math.max(1, Math.min(2000, parseInt(cols, 10) || s.cols));
  s.rows = Math.max(1, Math.min(1000, parseInt(rows, 10) || s.rows));
  s.child.stdio[3].write(`${JSON.stringify({ resize: [s.cols, s.rows] })}\n`);
  return true;
}

function kill(id) {
  const s = sessions.get(id);
  if (!s) return false;
  clearTimeout(s.reapTimer);
  sessions.delete(id);
  // Closing stdin is the helper's shutdown signal; SIGKILL is the backstop for
  // a helper wedged on a shell that ignores SIGHUP.
  try { s.child.stdin.end(); } catch {}
  try { s.child.kill(); } catch {}
  const hard = setTimeout(() => { try { s.child.kill('SIGKILL'); } catch {} }, 2000);
  if (hard.unref) hard.unref();
  return true;
}

// Server shutdown: a restart must not leave orphan shells behind.
function killAll() {
  for (const id of [...sessions.keys()]) kill(id);
}

module.exports = { create, list, get, forTask, attach, write, resize, kill, killAll, MAX_SESSIONS };
