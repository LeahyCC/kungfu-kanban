/* Archive tab: read-only browser over cards swept out of Done into
 * data/archive.jsonl. Fetched fresh on every tab open (the archive only
 * changes via the daily sweep, so no SSE wiring). */

import { $, esc, fmtTok, fmtLogTs, debounce } from './util.js';
import { api } from './api.js';
import { mdToHtml } from './markdown.js';

let items = [];

export async function loadArchive() {
  const r = await api('/api/archive');
  if (!r || r.error || !Array.isArray(r.items)) return;
  items = r.items;
  renderStats(r.stats);
  renderRows();
}

function renderStats(s) {
  const weeks = Object.entries(s.perWeek).sort().slice(-8);
  const repos = Object.entries(s.perRepo).sort((a, b) => b[1] - a[1]).slice(0, 6);
  $('#archiveStats').innerHTML =
    `<b>${s.total}</b> archived · ${fmtTok(s.tokensOut)} tok out` +
    (s.total ? ` · ~${fmtTok(Math.round(s.tokensOut / s.total))}/card` : '') +
    (weeks.length ? `<span class="a-weeks">${weeks.map(([w, n]) => `${esc(w.slice(5))}: ${n}`).join(' · ')}</span>` : '') +
    (repos.length ? `<span class="a-repos">${repos.map(([r, n]) => `${esc(r)} ×${n}`).join(' · ')}</span>` : '');
}

function renderRows() {
  const q = ($('#archiveSearch').value || '').trim().toLowerCase();
  const rows = items
    .filter((t) => !q || [t.title, t.cwd, t.model, t.group].filter(Boolean).join(' ').toLowerCase().includes(q))
    .map((t) => `<details class="archive-row" data-id="${esc(t.id)}">
      <summary><span class="a-title">${esc(t.title)}</span>
        <span class="a-meta">${esc(t.cwd ? t.cwd.split('/').pop() : '')} · ${esc(t.model || '')} · ${fmtTok(t.stats && t.stats.outputTokens)} tok · ${esc(fmtLogTs(t.finishedAt || t.createdAt))}${
          t.prUrl ? ` <a class="pr-link" href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR ↗</a>` : ''}</span>
      </summary><div class="a-body">loading…</div></details>`);
  $('#archiveList').innerHTML = rows.join('') || '<p class="sub">nothing archived yet — done cards land here after the sweep</p>';
}

// Full record (prompt + result) fetched once, on first expand. 'toggle' does
// not bubble, so listen in capture.
$('#archiveList').addEventListener('toggle', async (e) => {
  const row = e.target;
  if (!row.open || row.dataset.loaded) return;
  row.dataset.loaded = '1';
  const full = await api(`/api/archive/${row.dataset.id}`);
  if (!full || full.error) { row.querySelector('.a-body').textContent = 'failed to load'; return; }
  row.querySelector('.a-body').innerHTML =
    (full.prompt ? `<pre class="mono a-prompt">${esc(full.prompt)}</pre>` : '') +
    mdToHtml(full.resultText || '(no result)');
}, true);

$('#archiveSearch').addEventListener('input', debounce(renderRows, 150));
