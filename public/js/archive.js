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
  const cells = [
    ['ARCHIVED', String(s.total)],
    ['OUTPUT', fmtTok(s.tokensOut)],
    ['INPUT', fmtTok(s.tokensIn)],
    ['REPOS', String(Object.keys(s.perRepo || {}).length)],
    ['WEEKS', String(Object.keys(s.perWeek || {}).length)],
  ];
  $('#archiveStats').innerHTML = cells.map(([k, v]) =>
    `<div class="a-stat"><span class="a-k">${k}</span><span class="a-v">${esc(v)}</span></div>`).join('');
}

function renderRows() {
  const q = ($('#archiveSearch').value || '').trim().toLowerCase();
  const rows = items
    .filter((t) => !q || [t.title, t.cwd, t.model, t.group].filter(Boolean).join(' ').toLowerCase().includes(q))
    .map((t) => {
      const ts = t.finishedAt || t.createdAt;
      const when = ts ? `<time datetime="${esc(new Date(ts).toISOString())}" title="${esc(new Date(ts).toLocaleString())}">${esc(fmtLogTs(ts))}</time>` : '';
      return `<details class="archive-row" data-id="${esc(t.id)}">
      <summary><span class="a-title">${esc(t.title)}</span>
        <span class="a-meta">${esc(t.cwd ? t.cwd.split('/').pop() : '')} · ${esc(t.model || '')} · ${fmtTok(t.stats && t.stats.outputTokens)} tok · ${when}${
          t.prUrl ? ` <a class="pr-link" href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR ↗</a>` : ''}</span>
      </summary><div class="a-body">loading…</div></details>`;
    });
  $('#archiveList').innerHTML = rows.join('') ||
    `<div class="empty-col">${q
      ? 'no archived cards match your search'
      : 'nothing archived yet — done cards land here after the sweep'}</div>`;
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
