/* Card detail drawer: meta panel, status-gated actions, transcript entries,
 * follow-up. Also home to bypassAndRerun (shared with the attention popup). */

import { state, RUNNING_LIKE, COLUMNS, CTX_WINDOW } from './state.js';
import { $, esc, relTime, fmtTok, nearBottom } from './util.js';
import { api, confirmDlg, alertDlg, withBusy, toast } from './api.js';
import { depsUnmet, isPrUnshipped } from './deps.js';
import { mdToHtml } from './markdown.js';
import { loadTasks } from './board.js';
import { openModal } from './modals.js';

let drawerReturnFocus = null;
let lastDrawerActionsStatus = null; // rebuild only when status changes — a rebuild between mousedown/mouseup eats the click

export async function closeDrawer(force = false) {
  const t = state.tasks.find((x) => x.id === state.drawerId);
  if (!force && t && !$('#promptSaveBtn').classList.contains('hidden')
    && $('#promptEdit').value !== t.prompt
    && !(await confirmDlg('Discard the unsaved prompt edit?', { confirmLabel: 'Discard', danger: true }))) return;
  $('#drawer').classList.add('hidden');
  state.drawerId = null;
  if (drawerReturnFocus) { try { drawerReturnFocus.focus(); } catch {} drawerReturnFocus = null; }
}

export async function openDrawer(id) {
  drawerReturnFocus = document.activeElement;
  state.drawerId = id;
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  $('#drawerTitle').textContent = t.title;
  renderDrawerMeta(t);
  lastDrawerActionsStatus = null; // force rebuild — opening a card is not a status change
  renderDrawerActions(t);
  const entries = await api(`/api/tasks/${id}/transcript`);
  if (state.drawerId !== id) return;
  const box = $('#transcript');
  box.innerHTML = '';
  for (const e of entries) box.appendChild(entryEl(e));
  // t.error normally isn't persisted, so synthesize a line for it — but a
  // permission block already lives in the transcript as its own 'blocked'
  // entry, so skip it only when t.error IS that same note (a later, different
  // failure like a stop/crash must still show).
  const blocked = [...entries].reverse().find((e) => e.kind === 'blocked');
  if (t.error && !(blocked && blocked.text === t.error)) {
    box.appendChild(entryEl({ kind: 'error', text: t.error }));
  }
  box.classList.toggle('hidden', !box.children.length && !RUNNING_LIKE[t.status]);
  $('#followForm').classList.toggle('hidden', RUNNING_LIKE[t.status] || !t.sessionId);

  // the work: prompt shown and editable right here
  const pe = $('#promptEdit');
  pe.value = t.prompt || '';
  pe.disabled = !!RUNNING_LIKE[t.status];
  $('#promptSaveBtn').classList.add('hidden');

  $('#drawer').classList.remove('hidden');
  $('#drawerClose').focus();
  box.scrollTop = box.scrollHeight;
}

$('#promptEdit').addEventListener('input', () => {
  const t = state.tasks.find((x) => x.id === state.drawerId);
  $('#promptSaveBtn').classList.toggle('hidden', !t || $('#promptEdit').value === t.prompt);
});
$('#promptSaveBtn').addEventListener('click', async () => {
  if (!state.drawerId) return;
  const r = await api(`/api/tasks/${state.drawerId}`, { method: 'PATCH', body: { prompt: $('#promptEdit').value } });
  if (!r.error) $('#promptSaveBtn').classList.add('hidden');
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
    const box = $('#transcript');
    const pinned = nearBottom(box);
    box.appendChild(entryEl({ kind: 'error', text: r.error }));
    if (pinned) box.scrollTop = box.scrollHeight;
  } else {
    input.value = '';
  }
});

export function renderDrawerMeta(t) {
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
    sel.addEventListener('change', () => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { [field]: sel.value } }));
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

  const bits = [`cwd: ${t.cwd}`];
  if (t.prChecks) {
    const c = t.prChecks;
    bits.push(`CI: ${c.failing ? `✕ ${c.failing} failing — ${(c.failed || []).join(' · ')}` : c.pending ? `… ${c.pending} running` : c.noCi ? 'none on this repo' : c.passing ? `✓ ${c.passing} green` : '… waiting for checks'}${c.base ? ` · base ${c.base}` : ''}${c.wrongBase ? ` (card wants ${t.prBaseBranch})` : ''}`);
    if (c.conflicting) bits.push(`⚔ merge conflicts with ${c.base || 'the base branch'}`);
  }
  const unmetD = depsUnmet(t);
  if (unmetD.length) {
    const parts = unmetD.map((d) => isPrUnshipped(d) ? `${d.title} (done, awaiting merge)` : `${d.title} (not done)`);
    bits.push(`⛓ waits for: ${parts.join(' · ')}`);
  } else if ((t.deps || []).length) bits.push('⛓ all prerequisites done (satisfied)');
  const held = state.tasks.filter((x) => x.status === 'queued' && (x.deps || []).includes(t.id));
  if (held.length && (t.status !== 'done' || isPrUnshipped(t))) bits.push(`🖐 blocks: ${held.map((x) => x.title).join(' · ')}`);
  if ((t.depsUnresolved || []).length) bits.push(`⛓ unresolved: ${t.depsUnresolved.join(' · ')}`);
  if (t.createdAt) bits.push(`created ${relTime(t.createdAt)}`);
  if (t.updatedAt && t.updatedAt !== t.createdAt) bits.push(`updated ${relTime(t.updatedAt)}`);
  if (t.ctxTokens) bits.push(`ctx: ${fmtTok(t.ctxTokens)} (${Math.round((t.ctxTokens / CTX_WINDOW) * 100)}% of ${fmtTok(CTX_WINDOW)})`);
  if (t.modelUsed && t.model !== 'default' && !t.modelUsed.includes(t.model)) bits.unshift(`ran on: ${t.modelUsed}`);
  if (t.skills && t.skills.length) bits.push(`skills: ${t.skills.join(', ')}`);
  if (t.stats) {
    if (t.stats.turns) bits.push(`${t.stats.turns} turns`);
    if (t.stats.durationMs) bits.push(`${Math.round(t.stats.durationMs / 1000)}s`);
    if (t.stats.outputTokens) bits.push(`${t.stats.inputTokens || 0} in / ${t.stats.outputTokens} out tok`);
  }
  for (const b of bits) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = b;
    span.title = b; // long values (cwd paths) ellipsize — the tooltip has it all
    box.appendChild(span);
  }
  if (t.sessionId) {
    // claude -r resolves sessions per directory — the copy cd's there first
    const cmd = `cd ${JSON.stringify(t.runCwd || t.cwd)} && claude -r ${t.sessionId}`;
    const b = document.createElement('span');
    b.className = 'badge copyable';
    b.title = `Click to copy (sessions are per-directory, so this cd's into the run dir first):\n${cmd}`;
    b.textContent = `resume: claude -r ${t.sessionId}`;
    const idle = `resume: claude -r ${t.sessionId}`;
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
    a.textContent = `${t.prUrl} ↗`;
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
  if (RUNNING_LIKE[t.status]) {
    mk('⏹ Stop', 'danger', 'Stop the agent (SIGTERM; the partial transcript is kept)', () => api(`/api/tasks/${t.id}/stop`, { method: 'POST' }));
  } else {
    mk('▶ Run', 'primary', 'Launch now — re-running clears the previous transcript and result', async () => {
      if (t.resultText && !(await confirmDlg('Re-running clears the previous transcript and result. Continue?', { confirmLabel: '▶ Run' }))) return;
      await api(`/api/tasks/${t.id}/run`, { method: 'POST' });
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
      const r = to === 'queued'
        ? await api(`/api/tasks/${t.id}/run`, { method: 'POST' })
        : await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: to } });
      if (r.error) sel.value = t.status;
    });
    wrap.appendChild(sel);
    box.appendChild(wrap);
  }
}

export function entryEl(e) {
  const div = document.createElement('div');
  div.className = `t-entry ${e.kind}`;
  if (e.kind === 'assistant' || e.kind === 'result') {
    div.classList.add('md');
    div.innerHTML = mdToHtml(e.text);
  } else {
    div.textContent = e.text;
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
  toast(`"${t.title}" is back on the mats, running unrestricted.`, 'status');
}

$('#drawerClose').addEventListener('click', () => closeDrawer());
