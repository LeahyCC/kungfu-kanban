/* Card detail drawer: meta panel, status-gated actions, transcript entries,
 * follow-up. Also home to bypassAndRerun (shared with the attention popup).
 *
 * Performance behavior:
 * - SSE output events are rAF-batched: entries buffer per frame, then one
 *   nearBottom() read + one append run + one conditional scroll (was: a layout
 *   read AND a scroll write per chunk).
 * - Rendered transcript entries are capped at TRANSCRIPT_CAP; overflow drops
 *   from the TOP (never the tail) behind a sticky ".t-omitted" header row.
 * - renderDrawerMeta is change-gated on exactly the fields it renders, so SSE
 *   ticks no longer destroy open <select> dropdowns, focus, or the 'copied'
 *   feedback state.
 * - On open the drawer fetches the FULL task (GET /api/tasks/:id — SSE is going
 *   slim); a server without that endpoint 404s and we fall back to state. */

import { state, RUNNING_LIKE, COLUMNS, CTX_WINDOW } from './state.js';
import { $, esc, relTime, fmtTok, fmtClock, nearBottom } from './util.js';
import { api, confirmDlg, alertDlg, withBusy, toast } from './api.js';
import { depsUnmet, isPrUnshipped } from './deps.js';
import { mdToHtml } from './markdown.js';
import { loadTasks, applyOptimistic, rollbackOptimistic, mergeTaskResponse } from './board.js';
import { openModal } from './modals.js';
import { openCardTerminal, closeCardTerminal } from './term.js';

let drawerReturnFocus = null;
let lastDrawerActionsStatus = null; // rebuild only when status changes — a rebuild between mousedown/mouseup eats the click
let lastMetaKey = null; // renderDrawerMeta change gate (reset on every open)

// ---------- transcript: cap + rAF-batched appends ----------
const TRANSCRIPT_CAP = 500;
let omittedCount = 0; // entries dropped from the top for the current drawer view
let pendingEntries = [];
let flushScheduled = false;

// The #transcript element lives in index.html; its log semantics are set from
// here so screen readers announce appended output (additions only).
const transcriptBox = $('#transcript');
if (transcriptBox) {
  transcriptBox.setAttribute('role', 'log');
  transcriptBox.setAttribute('aria-live', 'polite');
  transcriptBox.setAttribute('aria-relevant', 'additions');
  // Tool rows clip to one line; click one to unclip it. A click that ends a
  // text selection is the user copying a command, not asking to expand.
  transcriptBox.addEventListener('click', (ev) => {
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel)) return;
    const row = ev.target && ev.target.closest && ev.target.closest('.t-entry.tool');
    if (row) row.classList.toggle('open');
  });
}

// Pure windowing: append the synthesized error entry (unless the identical
// permission-block entry already closes the log), then keep the LAST `cap`
// entries. The blocked-entry reverse scan runs on the FULL list, before
// capping. Exported for tests.
// ▶ Run can legitimately park a card instead of launching it (unmet deps, no
// free slot, a gate up). Silence there reads as a dead button — say why.
function notePark(r) {
  if (r && r.queued && r.reason) toast(`⛓ queued — ${r.reason}`, 'status');
  return r;
}

export function planTranscript(entries, taskError, cap = TRANSCRIPT_CAP) {
  const blocked = [...entries].reverse().find((e) => e.kind === 'blocked');
  const list = entries.slice();
  if (taskError && !(blocked && blocked.text === taskError)) list.push({ kind: 'error', text: taskError });
  const omitted = Math.max(0, list.length - cap);
  return { shown: omitted ? list.slice(omitted) : list, omitted };
}

function isOmittedHeader(node) {
  return !!(node && node.classList && node.classList.contains('t-omitted'));
}

function syncOmittedHeader(box) {
  const first = box.firstChild;
  if (isOmittedHeader(first)) {
    if (!omittedCount) { first.remove(); return; }
    first.textContent = `earlier output omitted — ${omittedCount} entries`;
    return;
  }
  if (!omittedCount) return;
  const head = document.createElement('div');
  head.className = 't-omitted';
  head.textContent = `earlier output omitted — ${omittedCount} entries`;
  box.insertBefore(head, first);
}

// Drop from the top until within the cap; the header row is never a victim.
function enforceCap(box) {
  let count = box.children.length - (isOmittedHeader(box.firstChild) ? 1 : 0);
  while (count > TRANSCRIPT_CAP) {
    const victim = isOmittedHeader(box.firstChild) ? box.firstChild.nextSibling : box.firstChild;
    if (!victim) break;
    victim.remove();
    omittedCount++;
    count--;
  }
  syncOmittedHeader(box);
}

// SSE 'output' and follow-up errors land here: buffer per frame, then a single
// append + a single bottom-pin check (60px threshold — readers in scrollback
// are never yanked).
export function appendTranscriptEntry(entry) {
  // Call sites that broadcast a fresh literal to SSE skip store.js's stamp;
  // a live entry's arrival time IS its timestamp, so fill it in here.
  if (!entry.ts) entry.ts = new Date().toISOString();
  pendingEntries.push(entry);
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(flushTranscript);
}

function flushTranscript() {
  flushScheduled = false;
  if (!pendingEntries.length) return;
  const box = $('#transcript');
  if (!box) { pendingEntries = []; return; }
  const entries = pendingEntries;
  pendingEntries = [];
  const pinned = nearBottom(box);
  for (const e of entries) box.appendChild(entryEl(e));
  enforceCap(box);
  if (pinned) box.scrollTop = box.scrollHeight;
}

// ---------- open / close ----------
export async function closeDrawer(force = false) {
  const t = state.tasks.find((x) => x.id === state.drawerId);
  if (!force && t && !$('#promptSaveBtn').classList.contains('hidden')
    && $('#promptEdit').value !== (t.prompt || '')
    && !(await confirmDlg('Discard the unsaved prompt edit?', { confirmLabel: 'Discard', danger: true }))) return;
  $('#drawer').classList.add('hidden');
  closeCardTerminal(); // the shell keeps running server-side; we stop watching it
  state.drawerId = null;
  if (drawerReturnFocus) { try { drawerReturnFocus.focus(); } catch {} drawerReturnFocus = null; }
}

export async function openDrawer(id) {
  drawerReturnFocus = document.activeElement;
  state.drawerId = id;
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;

  // paint instantly from state; the full task + transcript stream in below
  $('#drawerTitle').textContent = t.title;
  lastMetaKey = null;
  renderDrawerMeta(t);
  lastDrawerActionsStatus = null; // force rebuild — opening a card is not a status change
  renderDrawerActions(t);

  closeCardTerminal(); // opening a card must not show the last card's shell
  omittedCount = 0;
  pendingEntries = [];
  const box = $('#transcript');
  box.innerHTML = '';
  box.classList.add('hidden');

  const pe = $('#promptEdit');
  pe.value = t.prompt || '';
  pe.disabled = !!RUNNING_LIKE[t.status];
  $('#promptSaveBtn').classList.add('hidden');
  $('#followForm').classList.toggle('hidden', RUNNING_LIKE[t.status] || !t.sessionId);

  $('#drawer').classList.remove('hidden');
  $('#drawerClose').focus();

  // SSE task payloads are going slim (no prompt/resultText/acceptanceCriteria),
  // so the drawer fetches the full task. GET /api/tasks/:id may not exist on
  // this server yet — the {error} response falls back to the state task.
  const [full, entries] = await Promise.all([
    api(`/api/tasks/${id}`, { quiet: true }),
    api(`/api/tasks/${id}/transcript`),
  ]);
  if (state.drawerId !== id) return;

  let task = t;
  if (full && !full.error && full.id) {
    task = full;
    const i = state.tasks.findIndex((x) => x.id === id);
    if (i >= 0) state.tasks[i] = { ...state.tasks[i], ...full }; // top up the slim copy
    $('#drawerTitle').textContent = full.title || t.title;
    lastMetaKey = null;
    renderDrawerMeta(task);
    lastDrawerActionsStatus = null;
    renderDrawerActions(task);
    // adopt the full prompt only while the user hasn't started editing
    if ($('#promptSaveBtn').classList.contains('hidden')) pe.value = full.prompt || '';
    pe.disabled = !!RUNNING_LIKE[task.status];
    $('#followForm').classList.toggle('hidden', RUNNING_LIKE[task.status] || !task.sessionId);
  }

  const list = Array.isArray(entries) ? entries : [];
  const { shown, omitted } = planTranscript(list, task.error);
  omittedCount = omitted;
  for (const e of shown) box.appendChild(entryEl(e));
  syncOmittedHeader(box);
  box.classList.toggle('hidden', !box.children.length && !RUNNING_LIKE[task.status]);
  box.scrollTop = box.scrollHeight;
}

$('#promptEdit').addEventListener('input', () => {
  const t = state.tasks.find((x) => x.id === state.drawerId);
  $('#promptSaveBtn').classList.toggle('hidden', !t || $('#promptEdit').value === (t.prompt || ''));
});
$('#promptSaveBtn').addEventListener('click', () => {
  if (!state.drawerId) return;
  // busy/disabled for the whole PATCH — closes the double-save window
  withBusy($('#promptSaveBtn'), async () => {
    const r = await api(`/api/tasks/${state.drawerId}`, { method: 'PATCH', body: { prompt: $('#promptEdit').value } });
    if (!r.error) $('#promptSaveBtn').classList.add('hidden');
  });
});

$('#followForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.message;
  const btn = e.target.querySelector('button[type="submit"]');
  const msg = input.value.trim();
  if (!msg || !state.drawerId || (btn && btn.disabled)) return;
  if (btn) btn.disabled = true;
  const r = await api(`/api/tasks/${state.drawerId}/followup`, { method: 'POST', body: { message: msg }, quiet: true });
  if (btn) btn.disabled = false;
  if (r.error) {
    appendTranscriptEntry({ kind: 'error', text: r.error }); // batched + capped like SSE output
  } else {
    input.value = '';
  }
});

// ---------- meta panel (change-gated) ----------
// Fingerprint exactly what renderDrawerMeta renders: own fields, the state of
// every dependency and holder (their titles/statuses feed badges), and the
// config option lists. Anything else streaming in (~2s ticks for running
// cards) leaves the DOM — and open selects / focus / 'copied' feedback — alone.
function metaKey(t) {
  const depPart = (t.deps || []).map((id) => {
    const d = state.tasks.find((x) => x.id === id);
    return d ? `${d.v !== undefined ? 'v' + d.v : d.status}/${d.title}` : 'gone';
  }).join(',');
  const held = state.tasks
    .filter((x) => x.status === 'queued' && (x.deps || []).includes(t.id))
    .map((x) => `${x.id}:${x.title}`).join(',');
  const cfg = state.config;
  return JSON.stringify([
    t.v !== undefined ? t.v : null, t.status, t.model, t.effort, t.permissionMode, t.permissionBlocked,
    t.cwd, t.prChecks, t.deps, t.depsUnresolved, t.createdAt, t.updatedAt, t.ctxTokens,
    t.modelUsed, t.skills, t.stats, t.sessionId, t.runCwd, t.prUrl, t.prBaseBranch,
    depPart, held, cfg.models, cfg.efforts, cfg.permissionModes,
  ]);
}

export function renderDrawerMeta(t) {
  const key = metaKey(t);
  if (key === lastMetaKey) return;
  lastMetaKey = key;
  const box = $('#drawerMeta');
  box.innerHTML = '';
  const canEdit = !RUNNING_LIKE[t.status];

  // model + effort are live selects: change them right here, next run/follow-up
  // (and manager retries) use the new values
  const mkSel = (label, opts, value, field) => {
    const wrap = document.createElement('label');
    wrap.className = 'drawer-pick';
    wrap.append(label + ' ');
    const sel = document.createElement('select');
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = o;
      op.textContent = o;
      sel.appendChild(op);
    }
    sel.value = value || 'default';
    sel.disabled = !canEdit;
    sel.addEventListener('change', () => {
      if (sel.disabled) return;
      sel.disabled = true; // close the double-PATCH window
      api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { [field]: sel.value } })
        .then(() => { sel.disabled = !canEdit; });
    });
    wrap.appendChild(sel);
    box.appendChild(wrap);
  };
  mkSel('model', state.config.models, t.model, 'model');
  mkSel('effort', state.config.efforts, t.effort, 'effort');
  // Live too: a card blocked on permission is fixed by raising this, then re-running.
  mkSel('perms', state.config.permissionModes, t.permissionMode, 'permissionMode');
  if (t.permissionBlocked && t.permissionBlocked.length) {
    const bypass = document.createElement('button');
    bypass.className = 'danger';
    bypass.textContent = '⚡ Bypass & re-run';
    bypass.title = `Blocked on: ${t.permissionBlocked.join(', ')}`;
    bypass.addEventListener('click', (e) => withBusy(e.target, () => bypassAndRerun(t)));
    box.appendChild(bypass);
  }

  // Chips carry the short form; the full value lives in the title tooltip. A
  // drawer full of absolute paths and session UUIDs wrapped to six rows of
  // shouting mono and buried the two chips that matter (CI, blocked deps).
  const bits = [];
  const repo = String(t.cwd || '').replace(/\/+$/, '').split('/').pop();
  bits.push({ text: `cwd: ${repo || t.cwd}`, title: t.cwd });
  if (t.prChecks) {
    const c = t.prChecks;
    bits.push(`CI: ${c.failing ? `✕ ${c.failing} failing — ${(c.failed || []).join(' · ')}` : c.pending ? `… ${c.pending} running` : c.noCi ? 'none on this repo' : c.passing ? `✓ ${c.passing} green` : '… waiting for checks'}${c.base ? ` · base ${c.base}` : ''}${c.wrongBase ? ` (card wants ${t.prBaseBranch})` : ''}`);
    if (c.failing && c.infra) bits.push(`⛔ CI blocked by the GitHub account, not this code: ${c.infraNote || 'jobs never start — fix the Actions billing/spending limit'}`);
    if (c.conflicting) bits.push(`⚔ merge conflicts with ${c.base || 'the base branch'}`);
  }
  const unmetD = depsUnmet(t);
  if (unmetD.length) {
    const parts = unmetD.map((d) => isPrUnshipped(d) ? `${d.title} (done, awaiting merge)` : `${d.title} (not done)`);
    bits.push(`⛓ waits for: ${parts.join(' · ')}`);
  } else if ((t.deps || []).length) bits.push({ text: '⛓ deps met', title: 'All prerequisites are done' });
  const held = state.tasks.filter((x) => x.status === 'queued' && (x.deps || []).includes(t.id));
  if (held.length && (t.status !== 'done' || isPrUnshipped(t))) bits.push(`🖐 blocks: ${held.map((x) => x.title).join(' · ')}`);
  if ((t.depsUnresolved || []).length) bits.push(`⛓ unresolved: ${t.depsUnresolved.join(' · ')}`);
  // one age chip, not two
  if (t.createdAt) {
    const upd = t.updatedAt && t.updatedAt !== t.createdAt ? ` · updated ${relTime(t.updatedAt)}` : '';
    bits.push(`created ${relTime(t.createdAt)}${upd}`);
  }
  if (t.ctxTokens) {
    bits.push({
      text: `ctx ${Math.round((t.ctxTokens / CTX_WINDOW) * 100)}%`,
      title: `${fmtTok(t.ctxTokens)} of the ~${fmtTok(CTX_WINDOW)} context window`,
    });
  }
  if (t.modelUsed && t.model !== 'default' && !t.modelUsed.includes(t.model)) bits.unshift(`ran on: ${t.modelUsed}`);
  if (t.skills && t.skills.length) bits.push(`skills: ${t.skills.join(', ')}`);
  if (t.stats) {
    // one run-stats chip: turns · wall clock · tokens (was three)
    const s = t.stats;
    const run = [
      s.turns && `${s.turns} turns`,
      s.durationMs && `${Math.round(s.durationMs / 1000)}s`,
      s.outputTokens && `${fmtTok(s.outputTokens)} out`,
    ].filter(Boolean);
    if (run.length) {
      bits.push({
        text: run.join(' · '),
        title: `${s.inputTokens || 0} in / ${s.outputTokens || 0} out tokens`,
      });
    }
  }
  for (const b of bits) {
    const { text, title } = typeof b === 'string' ? { text: b, title: b } : b;
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = text;
    span.title = title; // shortened values keep the full string in the tooltip
    box.appendChild(span);
  }
  if (t.sessionId) {
    // claude -r resolves sessions per directory — the copy cd's there first
    const cmd = `cd ${JSON.stringify(t.runCwd || t.cwd)} && claude -r ${t.sessionId}`;
    const b = document.createElement('span');
    b.className = 'badge copyable';
    b.title = `Click to copy (sessions are per-directory, so this cd's into the run dir first):\n${cmd}`;
    // the UUID is unreadable and 60 chars wide — the copy carries it
    b.textContent = '⧉ resume session';
    const idle = '⧉ resume session';
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        b.textContent = '✓ copied';
      } catch {
        b.textContent = '✕ copy blocked';
      }
      setTimeout(() => { b.textContent = idle; }, 1200);
    });
    box.appendChild(b);
  }
  if (t.prUrl) {
    const a = document.createElement('a');
    a.className = 'pr-link';
    a.href = t.prUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = t.prUrl;
    // "PR #159" beats a wrapped 60-char URL; the tooltip and href keep the rest
    const num = /\/pull\/(\d+)/.exec(t.prUrl);
    a.textContent = num ? `PR #${num[1]} ↗` : `${t.prUrl} ↗`;
    box.appendChild(a);
  }
}

export function renderDrawerActions(t) {
  if (t.status === lastDrawerActionsStatus) return; // e.g. Stop mid-click would eat the click
  lastDrawerActionsStatus = t.status;
  const box = $('#drawerActions');
  box.innerHTML = '';
  const mk = (label, cls, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    if (title) b.title = title;
    b.addEventListener('click', () => withBusy(b, fn));
    box.appendChild(b);
  };
  // Every status gets a shell: on a running card to watch what it's doing, on a
  // finished one to check the diff or re-run the tests where the agent worked.
  if (state.config.settings && state.config.settings.terminal !== false) {
    mk('▸_ Terminal', 'ghost', "A shell in this card's own working tree — its git worktree when it has one", () => openCardTerminal(t.id));
  }
  if (RUNNING_LIKE[t.status]) {
    mk('⏹ Stop', 'danger', 'Stop the agent (SIGTERM; the partial transcript is kept)', () => api(`/api/tasks/${t.id}/stop`, { method: 'POST' }));
  } else {
    mk('▶ Run', 'primary', 'Launch now — re-running clears the previous transcript and result', async () => {
      if (t.resultText && !(await confirmDlg('Re-running clears the previous transcript and result. Continue?', { confirmLabel: '▶ Run' }))) return;
      notePark(await api(`/api/tasks/${t.id}/run`, { method: 'POST' }));
    });
    mk('Edit', 'ghost', 'Edit the card (prompt, model, schedule, …)', () => { closeDrawer(true); openModal(t); });
    if (t.status === 'review') mk('✓ Done', '', 'Stamp it shipped — moves the card to Done', async () => {
      if (!(await confirmDlg(`Approve "${t.title}" — stamp it Done?`, { confirmLabel: '✓ Approve' }))) return;
      await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
      closeDrawer(true);
    });
    if (t.prUrl && t.status !== 'done') {
      mk('⇉ Merge PR', '', 'Merge the pull request on GitHub (merge commit) and stamp the card Done', async () => {
        if (!(await confirmDlg(`Merge this PR?\n${t.prUrl}`, { confirmLabel: '⇉ Merge' }))) return;
        const r = await api(`/api/tasks/${t.id}/pr`, { method: 'POST', body: { action: 'merge' }, quiet: true });
        if (r.error) await alertDlg(`Merge failed: ${r.error}\n\nThe PR is untouched — resolve it on GitHub or retry.`);
      });
      mk('Close PR', 'ghost', 'Close the pull request on GitHub without merging (the branch and work remain)', async () => {
        if (!(await confirmDlg(`Close this PR without merging?\n${t.prUrl}`, { confirmLabel: 'Close PR', danger: true }))) return;
        const r = await api(`/api/tasks/${t.id}/pr`, { method: 'POST', body: { action: 'close' }, quiet: true });
        if (r.error) await alertDlg(`Close failed: ${r.error}`);
      });
    }
    mk('Delete', 'danger', 'Delete the card and its transcript (does not touch git or PRs)', async () => {
      if (!(await confirmDlg('Delete this card and its transcript?', { confirmLabel: 'Delete', danger: true }))) return;
      await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
      closeDrawer(true);
      await loadTasks();
    });

    // move-to-column: the touch-friendly (and keyboard-friendly) alternative
    // to drag & drop — phones can't drag HTML5 cards at all
    const wrap = document.createElement('label');
    wrap.className = 'drawer-pick';
    wrap.append('column ');
    const sel = document.createElement('select');
    sel.title = 'Move the card to another column (Queued launches it when a slot frees up)';
    for (const c of COLUMNS) {
      if (c.key === 'running') continue;
      const op = document.createElement('option');
      op.value = c.key;
      op.textContent = c.label;
      sel.appendChild(op);
    }
    sel.value = t.status;
    sel.addEventListener('change', async () => {
      const to = sel.value;
      if (to === t.status) return;
      if (to === 'done' && !(await confirmDlg(`Mark "${t.title}" as Done? No run happens — the card just ships.`, { confirmLabel: '✓ Ship it' }))) {
        sel.value = t.status;
        return;
      }
      // optimistic: the card moves on the board now; a failure rolls it back
      // (api already toasted) and the select snaps back
      sel.disabled = true;
      const prev = applyOptimistic(t.id, { status: to });
      const r = to === 'queued'
        ? notePark(await api(`/api/tasks/${t.id}/run`, { method: 'POST' }))
        : await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: to } });
      sel.disabled = false;
      if (!r || r.error) {
        rollbackOptimistic(t.id, prev);
        sel.value = t.status;
      } else {
        t.status = to; // the status gate below re-renders actions on next tick
        lastDrawerActionsStatus = null;
        renderDrawerActions(t);
        mergeTaskResponse(r);
      }
    });
    wrap.appendChild(sel);
    box.appendChild(wrap);
  }
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

export function entryEl(e) {
  const div = document.createElement('div');
  div.className = `t-entry ${e.kind}`;
  // The clock floats into the left gutter (ignored on .tool rows, which are
  // already flex) — so it leads every entry without re-shaping any of them.
  const clock = fmtClock(e.ts);
  if (clock) {
    const t = span('t-time', clock);
    t.title = new Date(e.ts).toLocaleString();
    div.appendChild(t);
  }
  if (e.kind === 'assistant' || e.kind === 'result') {
    div.classList.add('md');
    // into a child, not div.innerHTML — that would wipe the clock span
    const body = document.createElement('div');
    body.innerHTML = mdToHtml(e.text);
    div.appendChild(body);
  } else if (e.kind === 'tool') {
    // "Bash gh api …" → a terminal command line: bright tool name, dim
    // argument clipped to one line (CSS), full text on hover / click.
    const i = e.text.indexOf(' ');
    div.title = e.text;
    div.appendChild(span('t-tool-name', i < 0 ? e.text : e.text.slice(0, i)));
    if (i >= 0) div.appendChild(span('t-tool-args', e.text.slice(i + 1)));
  } else {
    div.appendChild(document.createTextNode(e.text));
  }
  return div;
}

// A card stalled because its permission mode wouldn't allow the tool it
// needed. Bypassing is a deliberate, human-initiated risk choice — it is
// NOT clamped by the manager's permissionCeiling like manager-picked modes are.
// Lives here (not the attention popup) so both callers import it downward.
export async function bypassAndRerun(t) {
  if (!(await confirmDlg(
    `Re-run "${t.title}" with bypassPermissions? It skips every permission prompt for this card.`,
    { confirmLabel: '⚡ Bypass & re-run', danger: true },
  ))) return;
  const r = await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { permissionMode: 'bypassPermissions' } });
  if (r.error) return;
  const r2 = await api(`/api/tasks/${t.id}/run`, { method: 'POST' });
  if (r2.error) return;
  if (notePark(r2).queued) return; // parked, not running — don't claim otherwise
  toast(`"${t.title}" is back on the mats, running unrestricted.`, 'status');
}

$('#drawerClose').addEventListener('click', () => closeDrawer());

// Test hook: module-level transcript state survives across tests in one process.
export function __resetDrawerForTests() {
  omittedCount = 0;
  pendingEntries = [];
  flushScheduled = false;
  lastMetaKey = null;
  lastDrawerActionsStatus = null;
}
