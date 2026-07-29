/* Built-in terminal: a real shell (your $SHELL, your ~/.zshrc, your prompt) on
 * a server-side pty, rendered by xterm.js in a bottom panel.
 *
 * Session lifetime is the SERVER's, not the tab's — closing the panel or
 * reloading the board leaves the shell running, and reopening reattaches with
 * scrollback. That is the whole point of not running a terminal in the tab:
 * `npm test` keeps going while you go read a card.
 *
 * Wire protocol (see server.js): SSE for output, POST for keystrokes, both
 * base64 — terminal bytes are binary, and a partial UTF-8 sequence split across
 * two frames must survive to be reassembled by xterm's decoder.
 *
 * xterm.js is imported on demand, so a board that never opens the terminal
 * never downloads it. */

import { $ } from './util.js';
import { api, toast } from './api.js';
import { state } from './state.js';

let term = null;      // xterm Terminal
let fit = null;       // FitAddon
let es = null;        // EventSource for the attached session
let sessionId = null;
let loading = null;   // in-flight import() of xterm

const panel = () => $('#termPanel');

// ---------- lazy xterm load ----------
async function loadXterm() {
  if (loading) return loading;
  loading = (async () => {
    if (!document.querySelector('link[data-xterm]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/xterm-css/xterm.css';
      link.dataset.xterm = '1';
      document.head.appendChild(link);
    }
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('/vendor/xterm/xterm.mjs'),
      import('/vendor/xterm-fit/addon-fit.mjs'),
    ]);
    return { Terminal, FitAddon };
  })();
  return loading;
}

// The board's ink slab, wearing a terminal's 16 ANSI colours: the dojo palette
// (warm paper on dark ink, vermillion accent) rather than a generic green-on-
// black, so the panel reads as part of the board.
const THEME = {
  background: '#1A1714',
  foreground: '#ECE5D6',
  cursor: '#E0524A',
  cursorAccent: '#1A1714',
  selectionBackground: 'rgba(224, 82, 74, 0.32)',
  black: '#1A1714',
  red: '#E0524A',
  green: '#8FA96B',
  yellow: '#E0A33A',
  blue: '#6FA3D4',
  magenta: '#B98BC4',
  cyan: '#6FB3AE',
  white: '#ECE5D6',
  brightBlack: '#978F80',
  brightRed: '#E8776F',
  brightGreen: '#A8C285',
  brightYellow: '#EEBE63',
  brightBlue: '#8FBCE4',
  brightMagenta: '#CDA6D6',
  brightCyan: '#8FCAC5',
  brightWhite: '#FFF8EA',
};

// Keystrokes ride one POST each, and concurrent fetches have NO ordering
// guarantee — type fast enough (or hold a key down, or sit on a tailnet where
// the round trip is tens of ms) and "ls" arrives at the pty as "sl". Serialize
// them: one request in flight at a time, and everything typed while it is out
// coalesces into the next one, so a burst costs fewer requests, not more.
// Exported for the ordering test.
export function inputQueue(send) {
  let pending = '';
  let inFlight = false;
  return function push(data) {
    pending += data;
    if (inFlight) return;
    inFlight = true;
    (async () => {
      try {
        while (pending) {
          const chunk = pending;
          pending = '';
          await send(chunk);
        }
      } catch {
        // Losing the keystrokes of one failed request is bad; a wedged queue
        // — or an unhandled rejection every time the network hiccups — is
        // worse. api() has already surfaced the failure. Anything typed since
        // is still in `pending` and goes out with the next push.
      } finally {
        inFlight = false;
      }
    })();
  };
}

function sendResize() {
  if (!term || !sessionId) return;
  api(`/api/term/${sessionId}/resize`, {
    method: 'POST',
    body: { cols: term.cols, rows: term.rows },
    quiet: true,
  });
}

function refit() {
  if (!fit || panel().classList.contains('hidden')) return;
  try { fit.fit(); } catch {}
  sendResize();
}

// ---------- attach / detach ----------
function detach() {
  if (es) { es.close(); es = null; }
}

function attach(id) {
  detach();
  sessionId = id;
  es = new EventSource(`/api/term/${id}/stream`);
  es.onmessage = (ev) => {
    if (!term || !ev.data) return;
    // base64 → bytes: xterm takes a Uint8Array and does its own UTF-8 decoding,
    // which is what keeps a multi-byte glyph split across frames intact.
    const bin = atob(ev.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    term.write(bytes);
  };
  es.addEventListener('gone', () => {
    detach();
    if (term) term.write('\r\n\x1b[38;5;245m[session no longer exists — ⌘J again for a new one]\x1b[0m\r\n');
    sessionId = null;
    renderTabs();
  });
  // EventSource reconnects on its own; a dead session answers with the 'gone'
  // event above, so there is nothing to babysit here.
  renderTabs();
}

// ---------- sessions ----------
async function newSession(cwd, label) {
  const r = await api('/api/term', {
    method: 'POST',
    body: { cwd, label, cols: (term && term.cols) || 80, rows: (term && term.rows) || 24 },
  });
  if (r.error) return null;
  if (term) term.reset();
  attach(r.id);
  refit();
  return r;
}

async function renderTabs() {
  const bar = $('#termTabs');
  if (!bar) return;
  const r = await api('/api/term', { quiet: true });
  const list = (r && r.sessions) || [];
  bar.textContent = '';
  for (const s of list) {
    const b = document.createElement('button');
    b.className = `term-tab${s.id === sessionId ? ' active' : ''}${s.exited ? ' dead' : ''}`;
    b.textContent = s.label;
    b.title = s.cwd + (s.exited ? ' — ended' : '');
    b.addEventListener('click', () => {
      if (s.id === sessionId) return;
      if (term) term.reset();
      attach(s.id);
      refit();
      term.focus();
    });
    bar.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'term-tab add';
  add.textContent = '＋';
  add.title = 'New shell in the default working directory';
  add.addEventListener('click', async () => {
    await newSession(state.config.settings.defaultCwd);
    if (term) term.focus();
  });
  bar.appendChild(add);
}

// ---------- open / close ----------
export async function openTerminal({ cwd, label } = {}) {
  const p = panel();
  p.classList.remove('hidden');
  document.body.classList.add('term-open');

  if (!term) {
    let mods;
    try {
      mods = await loadXterm();
    } catch (e) {
      toast('✕ could not load the terminal — is the server up to date? (npm i)');
      p.classList.add('hidden');
      document.body.classList.remove('term-open');
      return;
    }
    term = new mods.Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 13,
      // Prefer a Nerd Font when one is installed (starship's default prompt
      // leans on those glyphs), then fall back to the board's mono stack.
      fontFamily: '"JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", ui-monospace, SFMono-Regular, Menlo, monospace',
      lineHeight: 1.2,
      scrollback: 10000,
      macOptionIsMeta: true,
      theme: THEME,
    });
    fit = new mods.FitAddon();
    term.loadAddon(fit);
    term.open($('#termScreen'));
    const sendInput = inputQueue((chunk) => {
      // base64 so control bytes and pasted UTF-8 survive JSON transport intact
      const bytes = new TextEncoder().encode(chunk);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return api(`/api/term/${sessionId}/input`, { method: 'POST', body: { data: btoa(bin) }, quiet: true });
    });
    term.onData((data) => {
      if (!sessionId) return;
      sendInput(data);
    });
    term.onResize(() => sendResize());
    new ResizeObserver(() => refit()).observe($('#termScreen'));
  }

  // Reattach to a live session when there is one and the caller didn't ask for
  // a specific directory; otherwise open a fresh shell there.
  if (cwd) {
    await newSession(cwd, label);
  } else if (!sessionId) {
    const r = await api('/api/term', { quiet: true });
    const live = ((r && r.sessions) || []).find((s) => !s.exited);
    if (live) attach(live.id);
    else await newSession(state.config.settings.defaultCwd);
  }
  refit();
  term.focus();
  renderTabs();
}

export function closeTerminal() {
  // Deliberately does NOT kill the session — whatever is running keeps running,
  // and reopening reattaches. ✕ on the tab is how you actually end a shell.
  panel().classList.add('hidden');
  document.body.classList.remove('term-open');
  detach();
  sessionId = null;
}

export function isTerminalOpen() {
  return !panel().classList.contains('hidden');
}

export function toggleTerminal() {
  if (isTerminalOpen()) closeTerminal();
  else openTerminal();
}

// ---------- wiring ----------
$('#termToggle').addEventListener('click', () => toggleTerminal());
$('#termClose').addEventListener('click', () => closeTerminal());
$('#termKill').addEventListener('click', async () => {
  if (!sessionId) return closeTerminal();
  const dying = sessionId;
  detach();
  sessionId = null;
  await api(`/api/term/${dying}`, { method: 'DELETE', quiet: true });
  if (term) term.reset();
  const r = await api('/api/term', { quiet: true });
  const live = ((r && r.sessions) || []).find((s) => !s.exited);
  if (live) attach(live.id);
  else await newSession(state.config.settings.defaultCwd);
  renderTabs();
});
window.addEventListener('resize', () => refit());
