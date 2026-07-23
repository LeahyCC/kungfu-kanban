/* The Sensei (manager) tab, the error tracker, and the attention popup — kept
 * together because they cross-reference (renderManager → renderAttn, errors'
 * "Ask Sensei" → showTab, both → openDrawer). */

import { state } from './state.js';
import { $, nearBottom, fmtLogTs, fillSelect } from './util.js';
import { api, confirmDlg, withBusy, toast } from './api.js';
import { openDrawer, bypassAndRerun } from './drawer.js';
import { loadTasks } from './board.js';

// ---------- manager tab ----------
export function showTab(which) {
  $('#board').classList.toggle('hidden', which !== 'board');
  $('#boardToolbar').classList.toggle('hidden', which !== 'board');
  $('#managerView').classList.toggle('hidden', which !== 'manager');
  for (const [id, key] of [['#tabBoard', 'board'], ['#tabManager', 'manager']]) {
    const tab = $(id);
    tab.classList.toggle('active', which === key);
    tab.setAttribute('aria-selected', which === key ? 'true' : 'false');
    tab.tabIndex = which === key ? 0 : -1;
  }
  if (which === 'manager') loadManager();
}
$('#tabBoard').addEventListener('click', () => showTab('board'));
$('#tabManager').addEventListener('click', () => showTab('manager'));
// roving arrow-key navigation between the two tabs
document.querySelector('.app-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const other = document.activeElement === $('#tabBoard') ? $('#tabManager') : $('#tabBoard');
  e.preventDefault();
  other.focus();
  other.click();
});

export async function loadManager() {
  state.mgrState = await api('/api/manager');
  renderManager();
}

// SSE refreshes rewrite the settings form from server state — but never while
// the user has unsaved edits mid-form (that silently threw their input away).
let mgrFormDirty = false;
$('#mgrForm').addEventListener('input', () => { mgrFormDirty = true; });

export function setMgrBusy(busy) {
  $('#mgrBusy').classList.toggle('hidden', !busy);
  $('#mgrStopBtn').classList.toggle('hidden', !busy);
  const form = $('#mgrChatForm');
  form.message.disabled = !!busy;
  form.querySelector('button[type="submit"]').disabled = !!busy;
  form.message.placeholder = busy
    ? 'the Sensei is thinking — one run at a time…'
    : "e.g. plan the auth refactor into cards, or: what's blocking?";
}

export function renderManager() {
  if (!state.mgrState) return;
  const c = state.mgrState.config;
  const f = $('#mgrForm');
  if (!mgrFormDirty) {
    f.enabled.checked = !!c.enabled;
    fillSelect(f.model, state.config.models, c.model);
    fillSelect(f.effort, state.config.efforts, c.effort);
    f.autonomy.value = c.autonomy;
    f.stylePrompt.value = c.stylePrompt || '';
    f.onFinish.checked = !!c.triggers.onFinish;
    f.onNewCard.checked = !!c.triggers.onNewCard;
    f.intervalMin.value = c.triggers.intervalMin || 0;
    f.maxLaunchesPerHour.value = c.maxLaunchesPerHour;
    f.maxRetries.value = c.maxRetries;
    fillSelect(f.permissionCeiling, state.config.permissionModes, c.permissionCeiling);
  }

  setMgrBusy(state.mgrState.busy);

  // chat
  const chat = $('#mgrChat');
  const pinned = !chat.children.length || nearBottom(chat);
  chat.innerHTML = '';
  for (const m of state.mgrState.chat) {
    const div = document.createElement('div');
    div.className = `chat-msg ${m.role}`;
    div.textContent = m.text;
    chat.appendChild(div);
  }
  if (pinned) chat.scrollTop = chat.scrollHeight;

  // suggestions
  const sug = $('#mgrSuggestions');
  sug.innerHTML = '';
  if (!state.mgrState.suggestions.length) sug.innerHTML = '<div class="empty-col">nothing pending</div>';
  for (const s of state.mgrState.suggestions) sug.appendChild(suggestionCard(s));
  const pill = $('#suggCount');
  pill.textContent = state.mgrState.suggestions.length;
  pill.classList.toggle('hidden', !state.mgrState.suggestions.length);

  // log
  const logBox = $('#mgrLog');
  logBox.innerHTML = '';
  for (const e of state.mgrState.log) {
    const div = document.createElement('div');
    div.className = `log-entry ${e.kind}`;
    div.textContent = `${fmtLogTs(e.ts)} · ${e.kind} · ${e.text}`;
    logBox.appendChild(div);
  }

  renderAttn();
}

// shared by the "Pending suggestions" panel and the attention popup
function suggestionCard(s) {
  const div = document.createElement('div');
  div.className = 'suggestion';
  const head = document.createElement('div');
  head.className = 'sugg-head';
  head.textContent = describeAction(s.action) + (s.guard ? ` ⚠️ ${s.guard}` : '');
  const why = document.createElement('div');
  why.className = 'sugg-why';
  why.textContent = s.action.reasoning || '';
  const actions = document.createElement('div');
  actions.className = 'sugg-actions';
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = '✓ Approve';
  const no = document.createElement('button');
  no.className = 'danger';
  no.textContent = '✗ Reject';
  const decide = async (approve) => {
    ok.disabled = no.disabled = true;
    await api(`/api/manager/suggestions/${s.id}`, { method: 'POST', body: { approve } });
    await Promise.all([loadManager(), approve ? loadTasks() : Promise.resolve()]);
  };
  ok.addEventListener('click', () => decide(true));
  no.addEventListener('click', () => decide(false));
  actions.append(ok, no);
  div.append(head, why, actions);
  return div;
}

function describeAction(a) {
  switch (a.type) {
    case 'create_task': return `Create "${a.title}" [${a.model || 'default'}/${a.effort || 'default'}]${a.autoRun ? ' and run' : ''}`;
    case 'update_task': return `Update task ${taskTitle(a.taskId)}`;
    case 'run_task': return `Run ${taskTitle(a.taskId)}`;
    case 'approve_task': return `Approve ${taskTitle(a.taskId)} → Done`;
    case 'reject_task': return `Retry ${taskTitle(a.taskId)} with feedback: ${(a.feedback || '').slice(0, 100)}`;
    case 'followup_task': return `Follow up ${taskTitle(a.taskId)}: ${(a.message || '').slice(0, 100)}`;
    case 'requeue_task': return `Requeue ${taskTitle(a.taskId)} (no retry burned)`;
    case 'retarget_pr': return `Retarget the PR of ${taskTitle(a.taskId)} → base ${a.prBaseBranch || '?'}`;
    case 'resolve_error': return `Mark error ${(a.errorId || '?')} resolved in the tracker`;
    default: return a.type;
  }
}
function taskTitle(id) {
  const t = state.tasks.find((x) => x.id === id);
  return t ? `"${t.title}"` : (id || '?').slice(0, 8);
}

$('#mgrForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await api('/api/manager/config', {
    method: 'PUT',
    body: {
      enabled: f.enabled.checked,
      model: f.model.value,
      effort: f.effort.value,
      autonomy: f.autonomy.value,
      stylePrompt: f.stylePrompt.value,
      triggers: {
        onFinish: f.onFinish.checked,
        onNewCard: f.onNewCard.checked,
        intervalMin: parseInt(f.intervalMin.value, 10) || 0,
      },
      maxLaunchesPerHour: parseInt(f.maxLaunchesPerHour.value, 10) || 10,
      maxRetries: parseInt(f.maxRetries.value, 10) || 0,
      permissionCeiling: f.permissionCeiling.value,
    },
  });
  mgrFormDirty = false;
  await loadManager();
});

$('#clearChatBtn').addEventListener('click', async (e) => {
  if (!(await confirmDlg('Clear the Sensei chat history?', { confirmLabel: 'Clear', danger: true }))) return;
  await withBusy(e.target, async () => {
    await api('/api/manager/clear', { method: 'POST', body: { chat: true } });
    await loadManager();
  });
});
$('#clearLogBtn').addEventListener('click', async (e) => {
  if (!(await confirmDlg('Clear the activity log?', { confirmLabel: 'Clear', danger: true }))) return;
  await withBusy(e.target, async () => {
    await api('/api/manager/clear', { method: 'POST', body: { log: true } });
    await loadManager();
  });
});

$('#mgrChatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.message;
  const msg = input.value.trim();
  if (!msg || input.disabled || (state.mgrState && state.mgrState.busy)) return;
  input.value = '';
  setMgrBusy(true); // one Sensei run at a time — each is a paid subscription call
  (async () => {
    await api('/api/manager/chat', { method: 'POST', body: { message: msg } });
    await loadManager(); // renderManager restores the real busy state
  })();
});

// ---------- error tracker ----------
let errList = [];
let errReturnFocus = null;

export function renderErrChip(open) {
  const chip = $('#errChip');
  $('#errChipText').textContent = open;
  chip.classList.toggle('hidden', !open);
}

export async function loadErrors() {
  const r = await api('/api/errors', { quiet: true });
  if (!Array.isArray(r.errors)) return;
  errList = r.errors;
  renderErrChip(r.open || 0);
  if (!$('#errorsBackdrop').classList.contains('hidden')) renderErrList();
}

function renderErrList() {
  const box = $('#errList');
  box.innerHTML = '';
  if (!errList.length) {
    box.innerHTML = '<div class="empty-col">no errors logged — the dojo is at peace 🧘</div>';
    return;
  }
  for (const e of errList) {
    const row = document.createElement('div');
    row.className = `err-row${e.resolved ? ' resolved' : ''}`;
    const head = document.createElement('div');
    head.className = 'err-head';
    const kind = document.createElement('span');
    kind.className = 'badge err-kind';
    kind.textContent = e.kind;
    const when = document.createElement('span');
    when.className = 'err-when';
    when.textContent = fmtLogTs(e.lastAt || e.ts) + (e.count > 1 ? ` · ×${e.count}` : '');
    head.append(kind, when);
    if (e.taskTitle) {
      const card = document.createElement(e.taskId && state.tasks.some((t) => t.id === e.taskId) ? 'a' : 'span');
      card.className = 'err-card';
      card.textContent = e.taskTitle;
      if (card.tagName === 'A') {
        card.href = '#';
        card.title = 'Open this card';
        card.addEventListener('click', (ev) => { ev.preventDefault(); closeErrors(); openDrawer(e.taskId); });
      }
      head.append(card);
    }
    if (e.resolved) {
      const by = document.createElement('span');
      by.className = 'err-resolved-by';
      by.textContent = `✓ resolved${e.resolvedBy ? ` · ${e.resolvedBy}` : ''}`;
      head.append(by);
    } else {
      const ok = document.createElement('button');
      ok.className = 'ghost mini err-resolve';
      ok.textContent = '✓ resolve';
      ok.title = 'Mark handled — it stays in the history below for two weeks';
      ok.addEventListener('click', () => withBusy(ok, async () => {
        await api(`/api/errors/${e.id}/resolve`, { method: 'POST' });
        await loadErrors();
      }));
      head.append(ok);
    }
    const text = document.createElement('div');
    text.className = 'err-text';
    text.textContent = e.text;
    row.append(head, text);
    if (e.detail && e.detail !== e.text) {
      const detail = document.createElement('div');
      detail.className = 'err-detail';
      if (/^https:\/\/\S+$/.test(e.detail)) {
        const a = document.createElement('a');
        a.href = e.detail;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = e.detail;
        detail.appendChild(a);
      } else {
        detail.textContent = e.detail;
      }
      row.append(detail);
    }
    box.appendChild(row);
  }
}

function openErrors() {
  errReturnFocus = document.activeElement;
  renderErrList(); // last known state immediately…
  $('#errorsBackdrop').classList.remove('hidden');
  loadErrors(); // …then the fresh list
}
export function closeErrors() {
  $('#errorsBackdrop').classList.add('hidden');
  if (errReturnFocus) { try { errReturnFocus.focus(); } catch {} errReturnFocus = null; }
}

$('#errChip').addEventListener('click', openErrors);
$('#errCloseBtn').addEventListener('click', closeErrors);
$('#errorsBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeErrors();
});
$('#errResolveAllBtn').addEventListener('click', async (e) => {
  if (!(await confirmDlg('Mark every open error resolved without fixing anything?', { confirmLabel: '✓ Resolve all' }))) return;
  await withBusy(e.target, async () => {
    await api('/api/errors/resolve-all', { method: 'POST' });
    await loadErrors();
  });
});
$('#errAskSenseiBtn').addEventListener('click', (e) => withBusy(e.target, async () => {
  const msg = 'Fix the open errors in the error tracker (listed in your prompt under "Open operational errors"). '
    + 'Operations only: raise permissions and re-run permission-blocked cards, retarget wrong-base PRs (retarget_pr), '
    + 'recover stalled PR flows and launch failures — never fix code from here; ci-failing test/lint entries get '
    + 'reject_task with feedback instead. Mark every entry you handle resolved (resolve_error).';
  const r = await api('/api/manager/chat', { method: 'POST', body: { message: msg } });
  if (r.error) return;
  closeErrors();
  showTab('manager');
}));

// ---------- attention popup (Sensei suggestions + permission-blocked cards) ----------
// non-nagging: only auto-opens on the 0→N transition, mirroring errChip
let attnDismissed = false;
let attnPrevCount = 0;
let attnReturnFocus = null;

function attnBlocked() {
  return state.tasks.filter((t) => t.permissionBlocked && t.status === 'review');
}

function blockedCard(t) {
  const div = document.createElement('div');
  div.className = 'suggestion';
  const head = document.createElement('div');
  head.className = 'sugg-head';
  head.textContent = `Permission-blocked: "${t.title}"`;
  const why = document.createElement('div');
  why.className = 'sugg-why';
  why.textContent = (t.permissionBlocked || []).join(', ');
  const actions = document.createElement('div');
  actions.className = 'sugg-actions';
  const open = document.createElement('button');
  open.className = 'ghost';
  open.textContent = 'Open card';
  open.addEventListener('click', () => { closeAttn(); openDrawer(t.id); });
  const bypass = document.createElement('button');
  bypass.className = 'danger';
  bypass.textContent = '⚡ Bypass & re-run';
  bypass.addEventListener('click', (e) => withBusy(e.target, () => bypassAndRerun(t)));
  actions.append(open, bypass);
  div.append(head, why, actions);
  return div;
}

// shown once when any held suggestion is capped, so the human can either
// approve-all (runs regardless of the cap) or raise the ceiling for next time
function capNotice() {
  const div = document.createElement('div');
  div.className = 'suggestion';
  const why = document.createElement('div');
  why.className = 'sugg-why';
  const cur = (state.mgrState && state.mgrState.config && state.mgrState.config.maxLaunchesPerHour) || 0;
  why.textContent = `Some suggestions are held by the hourly launch cap (${cur}/hr). Approve-all still runs them now — Raise cap lifts the ceiling for future auto-launches.`;
  const actions = document.createElement('div');
  actions.className = 'sugg-actions';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.value = cur + 10;
  input.style.width = '5em';
  const raise = document.createElement('button');
  raise.className = 'ghost';
  raise.textContent = 'Raise cap';
  raise.addEventListener('click', (e) => withBusy(e.target, async () => {
    const n = parseInt(input.value, 10);
    if (!Number.isInteger(n) || n < 0) return;
    await api('/api/manager/config', { method: 'PUT', body: { maxLaunchesPerHour: n } });
    await loadManager();
  }));
  actions.append(input, raise);
  div.append(why, actions);
  return div;
}

export function renderAttn() {
  const sugg = (state.mgrState && state.mgrState.suggestions) || [];
  const blocked = attnBlocked();
  const count = sugg.length + blocked.length;

  $('#attnChipText').textContent = count;
  $('#attnChip').classList.toggle('hidden', !count);

  const box = $('#attnList');
  box.innerHTML = '';
  if (!count) box.innerHTML = '<div class="empty-col">nothing needs you — the dojo is at peace 🧘</div>';
  else {
    if (sugg.some((s) => s.guard === 'hourly launch cap reached')) box.appendChild(capNotice());
    for (const s of sugg) box.appendChild(suggestionCard(s));
    for (const t of blocked) box.appendChild(blockedCard(t));
  }

  if (count > 0 && attnPrevCount === 0 && !attnDismissed) openAttn();
  if (count === 0) attnDismissed = false;
  attnPrevCount = count;
}

function openAttn() {
  attnReturnFocus = document.activeElement;
  $('#attnBackdrop').classList.remove('hidden');
}
export function closeAttn() {
  $('#attnBackdrop').classList.add('hidden');
  attnDismissed = true;
  if (attnReturnFocus) { try { attnReturnFocus.focus(); } catch {} attnReturnFocus = null; }
}

$('#mgrStopBtn').addEventListener('click', (e) => withBusy(e.target, async () => {
  const r = await api('/api/manager/stop', { method: 'POST' });
  if (!r.error) toast('Sensei run stopped — nothing was applied.', 'status');
}));

$('#attnChip').addEventListener('click', openAttn);
$('#attnCloseBtn').addEventListener('click', closeAttn);
$('#attnBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeAttn();
});
// Approve/Reject all cover EVERYTHING in the popup, not just Sensei
// suggestions — a popup of only permission-blocked cards used to make both
// buttons silent no-ops. Approve = bypass & re-run the blocked cards (one
// confirm for the batch, since bypass is a deliberate risk choice); Reject =
// acknowledge and dismiss them.
$('#attnApproveAllBtn').addEventListener('click', (e) => withBusy(e.target, async () => {
  const sugg = (state.mgrState && state.mgrState.suggestions) || [];
  const blocked = attnBlocked();
  await Promise.all(sugg.map((s) => api(`/api/manager/suggestions/${s.id}`, { method: 'POST', body: { approve: true } })));
  if (blocked.length && await confirmDlg(
    `Re-run ${blocked.length} permission-blocked card${blocked.length > 1 ? 's' : ''} with bypassPermissions? It skips every permission prompt for ${blocked.length > 1 ? 'them' : 'it'}.`,
    { confirmLabel: '⚡ Bypass & re-run', danger: true },
  )) {
    for (const t of blocked) {
      const r = await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { permissionMode: 'bypassPermissions' } });
      if (!r.error) await api(`/api/tasks/${t.id}/run`, { method: 'POST' });
    }
  }
  await Promise.all([loadManager(), loadTasks()]);
}));
$('#attnRejectAllBtn').addEventListener('click', (e) => withBusy(e.target, async () => {
  const sugg = (state.mgrState && state.mgrState.suggestions) || [];
  const blocked = attnBlocked();
  await Promise.all(sugg.map((s) => api(`/api/manager/suggestions/${s.id}`, { method: 'POST', body: { approve: false } })));
  await Promise.all(blocked.map((t) => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { permissionBlocked: null } })));
  await Promise.all([loadManager(), loadTasks()]);
}));
