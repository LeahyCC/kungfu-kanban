/* Command palette + global hotkeys. One COMMANDS array serves three ways:
 * hotkey dispatch, palette rows, and (empty query) the shortcut help view. */

import { state, COLUMNS, RUNNING_LIKE } from './state.js';
import { $, esc, fuzzyScore } from './util.js';
import { haystackFor } from './board.js';
import { openDrawer } from './drawer.js';
import { openImportModal, openSettings } from './modals.js';
import { openComposer } from './composer.js';
import { showTab } from './manager.js';
import { toggleTerminal } from './term.js';

const COMMANDS = [
  { label: '＋ New cards', key: 'n', run: () => openComposer() },
  { label: '▸_ Terminal', key: 't', run: () => toggleTerminal() },
  { label: '⇪ Import / draft cards', key: 'i', run: () => openImportModal() },
  { label: '⌕ Filter cards', key: '/', run: () => { const f = $('#filterInput'); f.focus(); f.select(); } },
  { label: 'Go to Board', key: '1', run: () => showTab('board') },
  { label: 'Go to Sensei', key: '2', run: () => showTab('manager') },
  { label: 'Go to Archive', key: '3', run: () => showTab('archive') },
  { label: '⚙ Settings', run: () => openSettings() },
  { label: '◐ Toggle theme', run: () => $('#themeToggle').click() },
];

const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
  || t.tagName === 'SELECT' || t.isContentEditable);
const overlayOpen = () => !!(document.querySelector('.backdrop:not(.hidden):not(#paletteBackdrop)')
  || !$('#drawer').classList.contains('hidden')
  || document.querySelector('dialog.kk-dialog[open]'));
const paletteOpen = () => !$('#paletteBackdrop').classList.contains('hidden');

let returnFocus = null;
let items = [];
let active = 0;

export function openPalette() {
  returnFocus = document.activeElement;
  $('#paletteInput').value = '';
  renderList('');
  $('#paletteBackdrop').classList.remove('hidden');
  $('#paletteInput').focus();
}

export function closePalette() {
  $('#paletteBackdrop').classList.add('hidden');
  if (returnFocus) {
    try { returnFocus.focus(); } catch {}
    returnFocus = null;
  }
}

function colLabel(t) {
  if (RUNNING_LIKE[t.status]) return 'Running';
  const c = COLUMNS.find((x) => x.key === t.status);
  return c ? c.label : t.status;
}

function candidates(q) {
  const cmds = COMMANDS.map((c) => ({ ...c, score: fuzzyScore(q, c.label.toLowerCase()) }))
    .filter((c) => c.score);
  if (!q) return cmds; // empty query = the help view: every command + its key hint
  const cards = (state.tasks || [])
    .map((t) => ({ label: t.title, sub: colLabel(t), score: fuzzyScore(q, haystackFor(t)), run: () => openDrawer(t.id) }))
    .filter((c) => c.score);
  // stable sort: commands were pushed first, so they lead on score ties
  return [...cmds, ...cards].sort((a, b) => b.score - a.score).slice(0, 12);
}

function renderList(q) {
  items = candidates(q);
  active = 0;
  $('#paletteList').innerHTML = items.map((it, i) => `
    <li id="pal-opt-${i}" role="option" aria-selected="${i === 0}" data-i="${i}">
      <span class="pal-label">${esc(it.label)}</span>
      ${it.sub ? `<span class="pal-sub">${esc(it.sub)}</span>` : ''}
      ${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}
    </li>`).join('')
    || '<li class="pal-none" role="option" aria-selected="false" aria-disabled="true">no matches</li>';
  syncActive();
}

function syncActive() {
  for (const li of $('#paletteList').children) {
    const on = li.id === `pal-opt-${active}`;
    li.setAttribute('aria-selected', String(on));
    li.classList.toggle('active', on);
    if (on) li.scrollIntoView({ block: 'nearest' });
  }
  $('#paletteInput').setAttribute('aria-activedescendant', items.length ? `pal-opt-${active}` : '');
}

function runItem(it) {
  if (!it) return;
  closePalette(); // restore focus FIRST so an opened modal captures the real return target
  it.run();
}

$('#paletteInput').addEventListener('input', (e) => renderList(e.target.value.trim().toLowerCase()));
$('#paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); syncActive(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); syncActive(); }
  else if (e.key === 'Enter') { e.preventDefault(); runItem(items[active]); }
});
$('#paletteList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-i]');
  if (li) runItem(items[+li.dataset.i]);
});
$('#paletteBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closePalette();
});

// ---------- global hotkeys ----------
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (paletteOpen()) closePalette();
    else if (!overlayOpen()) openPalette();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (isTyping(e.target) || overlayOpen() || paletteOpen()) return;
  if (e.key === '?') { e.preventDefault(); openPalette(); return; }
  const cmd = COMMANDS.find((c) => c.key === e.key);
  if (cmd) { e.preventDefault(); cmd.run(); }
});
