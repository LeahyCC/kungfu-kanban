/* Contracts tab: the latest version of every published contract, and a
 * read-only view of any version's content. The list is fetched at boot, when
 * the tab opens and on the server's 'contracts' event; task events only re-resolve the
 * publishing card's title, which lives in state.tasks. Content is only ever
 * written with textContent, so a contract holding markup or markdown shows
 * literally. */

import { state } from './state.js';
import { $, esc, fmtLogTs } from './util.js';
import { api } from './api.js';
import { openDrawer, renderDrawerMeta } from './drawer.js';
import { render } from './board.js';

let items = [];
let selected = null; // { name, version, latest } — what the detail pane shows
let loadSeq = 0; // a slow response must not overwrite a newer pick

export const contractsVisible = () => !$('#contractsView').classList.contains('hidden');

// Loaded at boot and on every 'contracts' event, tab open or not: the board's
// `uses:` badges read state.contracts too.
export async function loadContracts() {
  const r = await api('/api/contracts');
  if (!r || r.error || !Array.isArray(r.contracts)) return;
  items = r.contracts;
  state.contracts = r.contracts;
  render(); // fingerprint-gated: a no-op unless a contract version changed
  const open = state.drawerId && state.tasks.find((x) => x.id === state.drawerId);
  if (open) renderDrawerMeta(open); // change-gated the same way
  renderRows();
  if (!selected) return;
  const row = items.find((c) => c.name === selected.name);
  if (!row) {
    selected = null;
    $('#contractDetail').classList.add('hidden');
    return;
  }
  // Someone reading the newest version follows it; someone reading an older
  // one stays put and just gains a newer option in the picker.
  const followLatest = selected.version === selected.latest;
  selected.latest = row.version;
  if (followLatest) selected.version = row.version;
  fillVersions();
  if (followLatest) showContent();
}

// Re-resolve card titles from state without refetching.
export function renderContractRows() {
  if (items.length) renderRows();
}

function cardCell(c) {
  if (!c.taskId) return '<span class="c-by-none">API</span>';
  const t = state.tasks.find((x) => x.id === c.taskId);
  if (!t) return '<span class="c-by-none" title="The publishing card is no longer on the board">(card removed)</span>';
  return `<button type="button" class="c-card" data-task="${esc(t.id)}" title="Open this card">${esc(t.title)}</button>`;
}

function renderRows() {
  const rows = items.map((c) => {
    const when = c.publishedAt
      ? `<time datetime="${esc(c.publishedAt)}" title="${esc(new Date(c.publishedAt).toLocaleString())}">${esc(fmtLogTs(c.publishedAt))}</time>`
      : '';
    const on = selected && selected.name === c.name;
    return `<div class="c-row${on ? ' selected' : ''}" data-name="${esc(c.name)}">
      <button type="button" class="c-name mono" aria-pressed="${on ? 'true' : 'false'}">${esc(c.name)}</button>
      <span class="c-ver mono">v${esc(String(c.version))}</span>
      <code class="c-sha" title="${esc(c.sha256)}">${esc(String(c.sha256).slice(0, 8))}</code>
      <span class="c-by">${cardCell(c)}</span>
      <span class="c-when">${when}</span>
    </div>`;
  });
  $('#contractsList').innerHTML = rows.join('') ||
    '<div class="empty-col">no contracts yet — a card publishes one with a “publishes:” line</div>';
}

function fillVersions() {
  const sel = $('#contractVersion');
  sel.innerHTML = '';
  for (let v = selected.latest; v >= 1; v--) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = v === selected.latest ? `v${v} (latest)` : `v${v}`;
    sel.appendChild(o);
  }
  sel.value = String(selected.version);
}

async function showContent() {
  const seq = ++loadSeq;
  const { name, version } = selected;
  $('#contractDetailName').textContent = name;
  const r = await api(`/api/contracts/${encodeURIComponent(name)}/${version}`);
  if (seq !== loadSeq) return;
  const pre = $('#contractContent');
  if (!r || r.error) {
    pre.textContent = 'failed to load';
    $('#contractDetailMeta').textContent = '';
    return;
  }
  pre.textContent = r.content;
  const c = r.contract;
  $('#contractDetailMeta').textContent = `${c.bytes} bytes · ${String(c.sha256).slice(0, 8)} · ${fmtLogTs(c.publishedAt)}`;
}

function select(name) {
  const row = items.find((c) => c.name === name);
  if (!row) return;
  selected = { name, version: row.version, latest: row.version };
  $('#contractDetail').classList.remove('hidden');
  renderRows();
  fillVersions();
  showContent();
  $('#contractDetail').scrollIntoView({ block: 'nearest' });
}

$('#contractsList').addEventListener('click', (e) => {
  const card = e.target.closest('.c-card');
  if (card) { openDrawer(card.dataset.task); return; }
  const row = e.target.closest('.c-row');
  if (row) select(row.dataset.name);
});

$('#contractVersion').addEventListener('change', (e) => {
  if (!selected) return;
  selected.version = Number(e.target.value);
  showContent();
});
