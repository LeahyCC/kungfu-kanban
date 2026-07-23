/* Kungfu Kanban frontend — entry module.
 *
 * The app was split from one 2000-line script into ./js/*.js ES modules. This
 * file is the entry point (index.html loads it as <script type="module">): it
 * wires the cross-cutting keyboard handling and the board toolbar, then runs
 * the boot sequence. Importing it evaluates the whole dependency graph first
 * (state → util → api → deps/markdown → board → drawer/modals → chips →
 * manager → sse), so every module's own listeners/intervals are already
 * attached before the boot IIFE below runs — matching the old top-to-bottom
 * order of the single file. Module scripts are deferred, so the DOM is ready. */

import { state } from './js/state.js';
import { $, debounce } from './js/util.js';
import { api } from './js/api.js';
import { render, loadTasks, setFilter } from './js/board.js';
import { closeDrawer } from './js/drawer.js';
import { closeTaskModal, closeImportModal, closeSettings } from './js/modals.js';
import { closeErrors, closeAttn, loadErrors, loadManager } from './js/manager.js';
import { applyCooldown, applyModelBlocks, renderNetChip, setServerOffline, renderHealth, renderUsage } from './js/chips.js';
import { connectSSE } from './js/sse.js';

// ---------- Escape + focus trap for modals, the drawer, and dialogs ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('dialog.kk-dialog[open]')) return; // <dialog> closes itself
    if (!$('#modalBackdrop').classList.contains('hidden')) { e.preventDefault(); closeTaskModal(); }
    else if (!$('#importBackdrop').classList.contains('hidden')) { e.preventDefault(); closeImportModal(); }
    else if (!$('#settingsBackdrop').classList.contains('hidden')) { e.preventDefault(); closeSettings(); }
    else if (!$('#errorsBackdrop').classList.contains('hidden')) { e.preventDefault(); closeErrors(); }
    else if (!$('#attnBackdrop').classList.contains('hidden')) { e.preventDefault(); closeAttn(); }
    else if (!$('#drawer').classList.contains('hidden')) { e.preventDefault(); closeDrawer(); }
    return;
  }
  if (e.key !== 'Tab') return;
  // the drawer is a sibling of the backdrops — without it here, Tab escaped
  // into the board behind the open drawer. A backdrop modal (if any) sits on
  // top and traps first.
  const overlay = document.querySelector('.backdrop:not(.hidden) .modal')
    || document.querySelector('.drawer:not(.hidden)');
  if (!overlay) return;
  const foci = [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!foci.length) return;
  const first = foci[0];
  const last = foci[foci.length - 1];
  if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
    e.preventDefault(); first.focus();
  }
});

// ---------- board filter ----------
// one render per pause in typing, not one full board pass per keystroke; the
// haystack itself is cached per task object inside board.js
const applyFilter = debounce((v) => {
  setFilter(v);
  render();
}, 120);
$('#filterInput').addEventListener('input', (e) => applyFilter(e.target.value.trim().toLowerCase()));

// ---------- inline settings ----------
$('#maxConcurrent').addEventListener('change', async (e) => {
  const prev = state.config.settings.maxConcurrent || 2;
  const r = await api('/api/settings', { method: 'PUT', body: { maxConcurrent: parseInt(e.target.value, 10) } });
  if (!r || r.error) { e.target.value = prev; return; } // don't leave the input out of sync with state
  state.config.settings = r;
});

// ---------- boot: visible loading + a real error state ----------
function bootError(msg) {
  $('#board').innerHTML = `
    <div class="dojo-empty boot-state">
      <h3>Can't reach the dojo</h3>
      <p class="boot-err"></p>
      <div class="empty-actions"><button class="primary" onclick="location.reload()">↻ Retry</button></div>
    </div>`;
  $('#board').classList.add('is-empty');
  $('#board').querySelector('.boot-err').textContent = msg;
}

(async () => {
  $('#board').innerHTML = '<div class="dojo-empty boot-state"><p class="boot-msg">contacting the dojo…</p></div>';
  $('#board').classList.add('is-empty');
  let cfg;
  try {
    cfg = await api('/api/config', { quiet: true });
  } catch (e) {
    cfg = { error: String(e.message || e) };
  }
  if (!cfg || cfg.error || !cfg.settings) {
    bootError(cfg && cfg.error ? cfg.error : 'the server did not answer — is it running?');
    return;
  }
  state.config = cfg;
  $('#board').classList.remove('is-empty');
  $('#maxConcurrent').value = state.config.settings.maxConcurrent || 2;
  applyCooldown(state.config.cooldownUntil || 0);
  setServerOffline(!!state.config.offline);
  renderNetChip();
  applyModelBlocks(state.config.modelBlocks || {});
  connectSSE(); // handlers exist before an early event can land
  if (!(await loadTasks())) { bootError('loaded config, but the task list failed — retry?'); return; }
  renderHealth();
  renderUsage();
  loadErrors();
  loadManager();
})();

// minimal service worker: makes "add to home screen" a real PWA (cached shell
// when offline); it never intercepts /api/, so live data stays live
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
