/* Status chips and their timers: subscription cooldown + model-block, theme
 * toggle, offline awareness, the 5-hour usage chip, and system health. */

import { $, esc, fmtTok, fmtMs } from './util.js';
import { api, confirmDlg, alertDlg } from './api.js';
import { loadTasks } from './board.js';

// ---------- subscription cooldown + model fallback chips ----------
let cooldownUntil = 0;
let modelBlocks = {};
export function applyCooldown(until) {
  cooldownUntil = until || 0;
  tickCooldown();
}
export function applyModelBlocks(blocks) {
  modelBlocks = blocks || {};
  tickCooldown();
}
function tickCooldown() {
  const chip = $('#cooldownChip');
  const ms = cooldownUntil - Date.now();
  if (ms <= 0) chip.classList.add('hidden');
  else {
    $('#cooldownTimer').textContent = fmtMs(ms);
    chip.classList.remove('hidden');
  }

  const mchip = $('#modelChip');
  const active = Object.entries(modelBlocks).filter(([, until]) => until > Date.now());
  if (!active.length) mchip.classList.add('hidden');
  else {
    $('#modelChipText').textContent = active
      .map(([m, until]) => `${m} ${fmtMs(until - Date.now())}`)
      .join(' · ');
    mchip.classList.remove('hidden');
  }
}
setInterval(tickCooldown, 1000);

// ---------- theme ----------
export function paintThemeToggle() {
  const light = document.documentElement.dataset.theme === 'light';
  const btn = $('#themeToggle');
  btn.textContent = light ? '☾' : '☀';
  btn.title = light ? 'Enter the night dojo' : 'Enter the day dojo';
  btn.setAttribute('aria-pressed', light ? 'true' : 'false');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = light ? '#F6F2E9' : '#141210';
}
$('#themeToggle').addEventListener('click', () => {
  const next = !(document.documentElement.dataset.theme === 'light');
  if (next) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('kk-theme', next ? 'light' : 'dark'); } catch {}
  paintThemeToggle();
});
paintThemeToggle();

// ---------- offline awareness ----------
// Chip shows when either this browser has no network or the server reports
// the internet down (a card died on a connectivity error).
let serverOffline = false;
export function setServerOffline(v) {
  serverOffline = !!v;
}
export function renderNetChip() {
  $('#netChip').classList.toggle('hidden', navigator.onLine && !serverOffline);
}
window.addEventListener('offline', renderNetChip);
window.addEventListener('online', () => {
  renderNetChip();
  loadTasks(); // close the gap the outage left
});

// ---------- 5-hour usage chip ----------
export async function renderUsage() {
  const u = await api('/api/usage');
  if (!u || u.output === undefined) return;
  const chip = $('#usageChip');
  const txt = $('#usageChipText');
  if (u.budgetTokens > 0) {
    const left = Math.max(0, u.budgetTokens - u.output);
    const pct = Math.round((u.output / u.budgetTokens) * 100);
    txt.textContent = `5h ${fmtTok(left)} left`;
    chip.classList.toggle('warn', pct >= 70 && pct < 90);
    chip.classList.toggle('bad', pct >= 90);
  } else {
    txt.textContent = `5h ${fmtTok(u.output)}`;
    chip.classList.remove('warn', 'bad');
  }
  chip.classList.remove('hidden');
  const bd = $('#usageBreakdown');
  bd.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'usage-grid';
  const stats = [
    [fmtTok(u.output), 'out tok', ''],
    [fmtTok(u.input), 'in tok', ''],
    [fmtTok(u.cacheRead), 'cached', ''],
    [String(u.turns), 'turns', ''],
  ];
  if (u.budgetTokens > 0) {
    const left = Math.max(0, u.budgetTokens - u.output);
    const pct = Math.round((u.output / u.budgetTokens) * 100);
    stats.unshift([fmtTok(left), 'left (5h)', pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok']);
  }
  for (const [val, label, tone] of stats) {
    const s = document.createElement('div');
    s.className = 'u-stat';
    const b = document.createElement('b');
    b.textContent = val;
    if (tone) b.className = tone;
    const l = document.createElement('span');
    l.textContent = label;
    s.append(b, l);
    grid.appendChild(s);
  }
  bd.appendChild(grid);
  if (u.budgetTokens > 0) {
    const pct = Math.min(100, Math.round((u.output / u.budgetTokens) * 100));
    const bar = document.createElement('div');
    bar.className = 'u-bar';
    const fill = document.createElement('div');
    fill.className = 'u-fill' + (pct >= 90 ? ' bad' : pct >= 70 ? ' warn' : '');
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    bar.title = `${pct}% of your ${fmtTok(u.budgetTokens)} budget`;
    bd.appendChild(bar);
  }
  const models = Object.entries(u.byModel || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (models.length) {
    const row = document.createElement('div');
    row.className = 'u-models';
    for (const [m, n] of models) {
      const chip = document.createElement('span');
      chip.className = 'badge';
      chip.textContent = `${m} ${fmtTok(n)}`;
      row.appendChild(chip);
    }
    bd.appendChild(row);
  }
  const cap = document.createElement('span');
  cap.className = 'footnote';
  cap.textContent = 'all Claude Code on this Mac · rolling 5-hour window';
  bd.appendChild(cap);
}
setInterval(renderUsage, 5 * 60_000);

// ---------- system status (claude CLI + gh health) ----------
export async function renderHealth() {
  const el = $('#sysStatus');
  const [h, v] = await Promise.all([api('/api/health'), api('/api/version')]);
  if (!h.claude) return; // auth redirect etc.
  const dot = (ok) => `<span class="sys-dot ${ok ? 'ok' : 'bad'}">●</span>`;
  const upBtn = h.claude.ok
    ? ' <button id="updateClaudeBtn" class="ghost mini" title="Update the Claude Code CLI in place (runs claude update)">↑ update</button>'
    : '';
  // "2.1.212 (Claude Code)" → "claude 2.1.212" — the parenthetical is noise here
  const claudeVer = `claude ${esc((h.claude.out || '').replace(/\s*\(.*\)$/, '') || '?')}`;
  const boardVer = v && v.version
    ? `kungfu v${esc(v.version)}${v.updateAvailable
      ? ` <button id="updateBoardBtn" class="ghost mini warn" title="Your clone is ${v.behind} commit${v.behind > 1 ? 's' : ''} behind origin — pulls fast-forward and restarts the board">⬆ ${v.remoteVersion ? `v${esc(v.remoteVersion)}` : 'update'} available</button>`
      : ''} · `
    : '';
  if (h.claude.ok && h.gh.ok) {
    el.innerHTML = `${boardVer}${dot(true)} ${claudeVer}${upBtn} · ${dot(true)} gh`;
  } else {
    el.innerHTML = boardVer + [
      h.claude.ok ? `${dot(true)} ${claudeVer}${upBtn}` : `${dot(false)} claude CLI not working — cards can't run`,
      h.gh.ok ? `${dot(true)} gh` : `${dot(false)} gh not authed — PR features off`,
    ].join(' · ');
  }
  const bb = $('#updateBoardBtn');
  if (bb) bb.addEventListener('click', async () => {
    if (!(await confirmDlg('Update the board to the latest code? It pulls from origin and restarts itself (blocked while cards are running). Under plain `npm start` the server stops instead — restart it after.', { confirmLabel: '⬆ Update' }))) return;
    bb.disabled = true;
    bb.textContent = '⬆ updating…';
    const r = await api('/api/system/update-board', { method: 'POST', quiet: true });
    if (r.error) {
      await alertDlg(`Update failed: ${r.error}`);
      renderHealth();
      return;
    }
    bb.textContent = '⬆ restarting…';
    // launchd throttles respawns (~10s) — poll until the server is back
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok || res.status === 302 || res.status === 401) {
          clearInterval(poll);
          location.reload();
        }
      } catch {}
    }, 3000);
  });
  const ub = $('#updateClaudeBtn');
  if (ub) ub.addEventListener('click', async () => {
    if (!(await confirmDlg('Update the Claude Code CLI now? Running agents finish on the old version; new runs use the new one.', { confirmLabel: '↑ Update' }))) return;
    ub.disabled = true;
    ub.textContent = '↑ updating…';
    const r = await api('/api/system/update-claude', { method: 'POST', quiet: true });
    await alertDlg(r.ok ? (r.output || 'Updated.') : `Update failed: ${r.error || 'unknown error'}`);
    renderHealth();
  });
}
// the tooltip promises "checked every few minutes" — keep that promise
setInterval(renderHealth, 5 * 60_000);
