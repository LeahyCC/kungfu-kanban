/* The three modals: new/edit card, import/draft, and settings. They share the
 * chip pickers and the open/close/dirty-snapshot idiom. */

import { state } from './state.js';
import { $, esc, scheduleToInput, fillSelect } from './util.js';
import { api, confirmDlg, withBusy } from './api.js';
import { loadTasks } from './board.js';
import { renderUsage } from './chips.js';

// ---------- card modal ----------
// A chip toggles by click, Enter, or Space, and reports its state to AT.
function chipify(chip) {
  chip.tabIndex = 0;
  chip.setAttribute('role', 'button');
  chip.setAttribute('aria-pressed', chip.classList.contains('on') ? 'true' : 'false');
  const toggle = () => {
    chip.classList.toggle('on');
    chip.setAttribute('aria-pressed', chip.classList.contains('on') ? 'true' : 'false');
  };
  chip.addEventListener('click', toggle);
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
}

let modalSnapshot = '';
let modalReturnFocus = null;

function taskFormSnapshot() {
  const f = $('#taskForm');
  return JSON.stringify([
    f.title.value, f.prompt.value, f.cwd.value, f.model.value, f.effort.value,
    f.permissionMode.value, f.agent.value, f.worktree.checked, f.openPr.checked,
    f.priority.value, f.acceptanceCriteria.value, f.group.value, f.schedule.value,
    [...document.querySelectorAll('#skillPicker .skill-chip.on')].map((c) => c.dataset.name || 'auto'),
    [...document.querySelectorAll('#depPicker .skill-chip.on')].map((c) => c.dataset.id),
  ]);
}

export async function closeTaskModal(force = false) {
  if (!force && taskFormSnapshot() !== modalSnapshot) {
    if (!(await confirmDlg('Discard unsaved changes to this card?', { confirmLabel: 'Discard', danger: true }))) return;
  }
  $('#modalBackdrop').classList.add('hidden');
  if (modalReturnFocus) { try { modalReturnFocus.focus(); } catch {} modalReturnFocus = null; }
}

export function openModal(task) {
  modalReturnFocus = document.activeElement;
  state.editingId = task ? task.id : null;
  $('#modalTitle').textContent = task ? 'Edit card' : 'New card';
  const f = $('#taskForm');
  f.title.value = task ? task.title : '';
  f.prompt.value = task ? task.prompt : '';
  f.cwd.value = task ? task.cwd : state.config.settings.defaultCwd || '';

  // repo picker fills the cwd input; the input stays the source of truth
  const rs = $('#repoSelect');
  rs.innerHTML = '<option value="">repo…</option>';
  for (const r of state.config.repos || []) {
    const opt = document.createElement('option');
    opt.value = r.path;
    opt.textContent = r.name;
    rs.appendChild(opt);
  }
  rs.value = (state.config.repos || []).some((r) => r.path === f.cwd.value) ? f.cwd.value : '';
  rs.onchange = () => { if (rs.value) f.cwd.value = rs.value; };
  f.cwd.oninput = () => { rs.value = (state.config.repos || []).some((r) => r.path === f.cwd.value) ? f.cwd.value : ''; };
  fillSelect(f.model, state.config.models, task ? task.model : 'default');
  fillSelect(f.effort, state.config.efforts, task ? task.effort : 'default');
  fillSelect(f.permissionMode, state.config.permissionModes, task ? task.permissionMode : (state.config.settings.defaultPermissionMode || 'acceptEdits'));
  const agentOpts = ['', ...state.config.agents.map((a) => a.name)];
  fillSelect(f.agent, agentOpts, task && task.agent ? task.agent : '');
  f.worktree.checked = task ? !!task.worktree : false;
  f.openPr.checked = task ? !!task.openPr : false;
  f.priority.value = String(task && task.priority ? task.priority : 0);
  f.acceptanceCriteria.value = task ? task.acceptanceCriteria || '' : '';
  f.group.value = task ? task.group || '' : '';
  f.schedule.value = task ? scheduleToInput(task.schedule) : '';
  $('#groupList').innerHTML = [...new Set(state.tasks.map((t) => t.group).filter(Boolean))]
    .map((g) => `<option value="${esc(g)}"></option>`).join('');

  const picker = $('#skillPicker');
  picker.innerHTML = '';
  const auto = document.createElement('span');
  // new cards default to auto-select; editing reflects the card's saved choice
  auto.className = 'skill-chip auto' + ((task ? task.skillsAuto : true) ? ' on' : '');
  auto.textContent = '✦ auto-select';
  auto.title = 'Let the agent pick relevant skills itself';
  auto.dataset.auto = '1';
  chipify(auto);
  picker.appendChild(auto);
  const selected = new Set(task ? task.skills || [] : []);
  // New cards pre-select ponytail and humanizer (the repo-shipped skills).
  // First match only — skills are sorted, so the user-skill copy wins over a
  // plugin copy (ponytail:ponytail) and we never double-select.
  if (!task) {
    for (const name of ['ponytail', 'humanizer']) {
      const s = state.config.skills.find((x) => x.name === name || x.name.endsWith(':' + name));
      if (s) selected.add(s.name);
    }
  }
  for (const s of state.config.skills) {
    const chip = document.createElement('span');
    chip.className = 'skill-chip' + (selected.has(s.name) ? ' on' : '');
    chip.textContent = s.name;
    chip.title = s.description || '';
    chip.dataset.name = s.name;
    chipify(chip);
    picker.appendChild(chip);
  }
  // Filter box: hides non-matching chips by name/description; chips already
  // ON stay visible so a filtered view can't hide what the card will save.
  const search = $('#skillSearch');
  search.value = '';
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const chip of picker.querySelectorAll('.skill-chip')) {
      if (chip.dataset.auto) continue; // ✦ auto-select always shows
      const hit = !q || chip.classList.contains('on')
        || (chip.dataset.name || '').toLowerCase().includes(q)
        || (chip.title || '').toLowerCase().includes(q);
      chip.classList.toggle('hidden', !hit);
    }
  };
  // "Runs after" picker: every other card is a candidate prerequisite. Current
  // deps lead, then live cards column-first; done cards only show if already
  // selected (a done dep is met — nothing to add there).
  const dp = $('#depPicker');
  dp.innerHTML = '';
  const chosen = new Set(task ? task.deps || [] : []);
  const candidates = state.tasks
    .filter((c) => (!task || c.id !== task.id) && (chosen.has(c.id) || c.status !== 'done'))
    .sort((a, b) => (chosen.has(b.id) - chosen.has(a.id)) || (b.priority || 0) - (a.priority || 0))
    .slice(0, 40);
  if (!candidates.length) {
    dp.innerHTML = '<span class="footnote">no other cards on the board</span>';
  }
  for (const c of candidates) {
    const chip = document.createElement('span');
    chip.className = 'skill-chip' + (chosen.has(c.id) ? ' on' : '');
    chip.textContent = `⛓ ${c.title.slice(0, 40)}${c.title.length > 40 ? '…' : ''}`;
    chip.title = `${c.title} (${c.status})`;
    chip.dataset.id = c.id;
    chipify(chip);
    dp.appendChild(chip);
  }
  $('#modalBackdrop').classList.remove('hidden');
  f.title.focus();
  modalSnapshot = taskFormSnapshot();
}

$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f.querySelector('button[type="submit"]'), async () => {
  const body = {
    title: f.title.value,
    prompt: f.prompt.value,
    cwd: f.cwd.value,
    model: f.model.value,
    effort: f.effort.value,
    permissionMode: f.permissionMode.value,
    agent: f.agent.value || null,
    worktree: f.worktree.checked,
    openPr: f.openPr.checked,
    priority: parseInt(f.priority.value, 10) || 0,
    acceptanceCriteria: f.acceptanceCriteria.value,
    group: f.group.value,
    schedule: f.schedule.value,
    skills: [...document.querySelectorAll('#skillPicker .skill-chip.on')].filter((c) => !c.dataset.auto).map((c) => c.dataset.name),
    skillsAuto: !!document.querySelector('#skillPicker .skill-chip.auto.on'),
    deps: [...document.querySelectorAll('#depPicker .skill-chip.on')].map((c) => c.dataset.id),
  };
  const r = state.editingId
    ? await api(`/api/tasks/${state.editingId}`, { method: 'PATCH', body })
    : await api('/api/tasks', { method: 'POST', body });
  if (r.error) return; // api() already toasted — keep the modal open, nothing is lost
  closeTaskModal(true);
  await loadTasks();
  });
});

$('#newTaskBtn').addEventListener('click', () => openModal(null));
$('#cancelBtn').addEventListener('click', () => closeTaskModal());
$('#modalBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeTaskModal();
});

// ---------- import modal ----------
let draftSessionId = null;
let importReturnFocus = null;

// One channel for import feedback; errors get the error color, not success green.
function importResult(text, isErr = false) {
  const el = $('#importResult');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

export async function closeImportModal(force = false) {
  const hasDraft = $('#importText').value.trim();
  if (!force && hasDraft
    && !(await confirmDlg('Close and discard the draft in the import box?', { confirmLabel: 'Discard', danger: true }))) return;
  if (importOp) importOp.ctrl.abort(); // closing the modal cancels in-flight work
  $('#importBackdrop').classList.add('hidden');
  if (importReturnFocus) { try { importReturnFocus.focus(); } catch {} importReturnFocus = null; }
}

$('#importBtn').addEventListener('click', () => {
  importReturnFocus = document.activeElement;
  importResult('');
  draftSessionId = null;
  $('#refineRow').classList.add('hidden');
  const dr = $('#draftRepo');
  dr.innerHTML = '<option value="">repo…</option>';
  for (const r of state.config.repos || []) {
    const opt = document.createElement('option');
    opt.value = r.path;
    opt.textContent = r.name;
    dr.appendChild(opt);
  }
  updatePreview();
  $('#importBackdrop').classList.remove('hidden');
  $('#importText').focus();
});

// live parse preview + duplicate-title guard
let previewTimer = null;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const md = $('#importText').value;
    const box = $('#importPreview');
    if (!md.trim()) { box.textContent = ''; return; }
    const r = await api('/api/import/preview', { method: 'POST', body: { markdown: md } });
    if (!r.cards || !r.cards.length) { box.textContent = '✕ no cards found — need ## headings or - [ ] items'; return; }
    box.innerHTML = '';
    box.append(`will create ${r.cards.length} card${r.cards.length === 1 ? '' : 's'}: `);
    box.append(r.cards.map((c) => c.title).join(' · '));
    if (r.dupes && r.dupes.length) {
      const warn = document.createElement('span');
      warn.className = 'dupe';
      warn.textContent = ` ⚠ already on the board: ${r.dupes.join(', ')}`;
      box.appendChild(warn);
    }
  }, 400);
}
$('#importText').addEventListener('input', updatePreview);
$('#importCancelBtn').addEventListener('click', () => closeImportModal());
$('#importBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeImportModal();
});
// One import-modal operation at a time. The active button becomes ✕ cancel;
// cancelling aborts the request, which also kills the server-side claude
// process (no subscription burn continues). Other action buttons disable.
let importOp = null;
const importOpBtns = () => [$('#draftBtn'), $('#refineBtn'), $('#issuesBtn')];

function importOpDone() {
  if (!importOp) return;
  importOp.btn.textContent = importOp.orig;
  for (const b of importOpBtns()) b.disabled = false;
  importOp = null;
}

function cancelIfBusy(btn) {
  if (!importOp) return false;
  if (importOp.btn === btn) importOp.ctrl.abort();
  return true; // busy either way — swallow the click
}

async function runImportOp(btn, busyMsg, url, body) {
  const ctrl = new AbortController();
  importOp = { ctrl, btn, orig: btn.textContent };
  for (const b of importOpBtns()) b.disabled = b !== btn;
  btn.textContent = '✕ cancel';
  importResult(busyMsg);
  let r;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 401) { location.href = '/login'; return null; }
    r = await res.json();
  } catch (e) {
    r = { error: e.name === 'AbortError' ? 'cancelled' : String(e.message || e) };
  }
  importOpDone();
  return r;
}

$('#draftBtn').addEventListener('click', async (e) => {
  if (cancelIfBusy(e.target)) return;
  const request = $('#draftPrompt').value.trim();
  if (!request) return;
  const explore = $('#exploreToggle').checked;
  const repoPath = $('#draftRepo').value || null;
  if (explore && !repoPath) {
    importResult('✕ 🔍 explore needs a repo — pick one in the dropdown first', true);
    return;
  }
  const r = await runImportOp(
    e.target,
    explore ? '✨ exploring the repo & drafting (can take a couple minutes) — tap ✕ to cancel' : '✨ drafting — tap ✕ to cancel',
    '/api/import/draft',
    { request, repoPath, explore }
  );
  if (!r) return;
  if (r.markdown) {
    $('#importText').value = r.markdown;
    draftSessionId = r.sessionId || draftSessionId;
    $('#refineRow').classList.toggle('hidden', !draftSessionId);
    importResult('✓ draft ready — review, edit (or ↻ refine), then Import');
    updatePreview();
  } else {
    importResult(r.error === 'cancelled' ? '✕ cancelled' : `✕ ${r.error || 'draft failed'}`, true);
  }
});

$('#refineBtn').addEventListener('click', async (e) => {
  if (cancelIfBusy(e.target)) return;
  const msg = $('#refinePrompt').value.trim();
  if (!msg || !draftSessionId) return;
  const r = await runImportOp(e.target, '↻ refining — tap ✕ to cancel', '/api/import/draft', { refine: msg, sessionId: draftSessionId });
  if (!r) return;
  if (r.markdown) {
    $('#refinePrompt').value = '';
    $('#importText').value = r.markdown;
    draftSessionId = r.sessionId || draftSessionId;
    importResult('✓ refined — review, then Import');
    updatePreview();
  } else {
    importResult(r.error === 'cancelled' ? '✕ cancelled' : `✕ ${r.error || 'refine failed'}`, true);
  }
});

$('#issuesBtn').addEventListener('click', async (e) => {
  if (cancelIfBusy(e.target)) return;
  const repoPath = $('#draftRepo').value;
  if (!repoPath) { importResult('✕ pick a repo first', true); return; }
  const r = await runImportOp(e.target, '⇣ fetching open issues — tap ✕ to cancel', '/api/import/issues', { repoPath });
  if (!r) return;
  if (r.error) importResult(r.error === 'cancelled' ? '✕ cancelled' : `✕ ${r.error}`, true);
  else if (!r.count) importResult('no open issues in that repo');
  else {
    $('#importText').value = r.markdown;
    importResult(`✓ ${r.count} issue${r.count === 1 ? '' : 's'} → review, then Import (PRs will say Fixes #N)`);
    updatePreview();
  }
});

$('#fmtExample').addEventListener('click', async (e) => {
  const pre = e.currentTarget;
  try {
    await navigator.clipboard.writeText(pre.textContent);
    importResult('✓ template copied');
  } catch {
    importResult('✕ copy blocked by browser', true);
  }
  pre.classList.add('copied');
  setTimeout(() => pre.classList.remove('copied'), 1200);
});

$('#importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $('#importText').value = reader.result; updatePreview(); };
  reader.readAsText(file);
});
$('#importForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const md = $('#importText').value;
  if (!md.trim()) return;
  withBusy(e.target.querySelector('button[type="submit"]'), async () => {
    const r = await api('/api/import', { method: 'POST', body: { markdown: md }, quiet: true });
    if (r.error) {
      importResult(`✕ ${r.error}`, true);
    } else if (!r.created) {
      importResult('✕ no cards found — need ## headings or - [ ] items', true);
    } else {
      importResult(`✓ ${r.created} card${r.created === 1 ? '' : 's'} created`);
      $('#importText').value = '';
      $('#importFile').value = '';
      await loadTasks();
      setTimeout(() => closeImportModal(true), 900);
    }
  });
});

// ---------- settings modal ----------
let settingsReturnFocus = null;
let settingsSnapshot = '';

function settingsFormSnapshot() {
  const f = $('#settingsForm');
  return JSON.stringify([
    f.defaultCwd.value, f.defaultPermissionMode.value, f.reposDir.value, f.ntfyTopic.value,
    f.notifyMac.checked, f.keepAwake.checked, f.archiveDays.value, f.prWatchMin.value,
    f.prWatchAutoFix.checked, f.usageBudgetM.value,
  ]);
}

export async function closeSettings(force = false) {
  if (!force && settingsFormSnapshot() !== settingsSnapshot) {
    if (!(await confirmDlg('Discard unsaved settings changes?', { confirmLabel: 'Discard', danger: true }))) return;
  }
  $('#settingsBackdrop').classList.add('hidden');
  if (settingsReturnFocus) { try { settingsReturnFocus.focus(); } catch {} settingsReturnFocus = null; }
}

export function openSettings() {
  settingsReturnFocus = document.activeElement;
  $('#logoutBtn').classList.toggle('hidden', !state.config.authGate);
  const f = $('#settingsForm');
  f.defaultCwd.value = state.config.settings.defaultCwd || '';
  fillSelect(f.defaultPermissionMode, state.config.permissionModes, state.config.settings.defaultPermissionMode || 'acceptEdits');
  f.reposDir.value = state.config.settings.reposDir || '';
  f.ntfyTopic.value = state.config.settings.ntfyTopic || '';
  f.notifyMac.checked = state.config.settings.notifyMac !== false;
  f.keepAwake.checked = state.config.settings.keepAwake !== false;
  f.archiveDays.value = state.config.settings.archiveDays ?? 7;
  f.prWatchMin.value = Number.isInteger(state.config.settings.prWatchMin) ? state.config.settings.prWatchMin : 10;
  f.prWatchAutoFix.checked = state.config.settings.prWatchAutoFix !== false;
  f.usageBudgetM.value = (state.config.settings.usageBudgetTokens || 0) / 1_000_000;
  renderUsage();
  renderSkillStatus();
  api('/api/version').then((v) => {
    if (v && v.version) $('#settingsVersion').textContent = `v${v.version}`;
  });
  $('#settingsBackdrop').classList.remove('hidden');
  f.usageBudgetM.focus(); // first input — same convention as the card modal's f.title.focus()
  settingsSnapshot = settingsFormSnapshot();
}
async function renderSkillStatus() {
  const r = await api('/api/skill');
  const list = r.skills || [];
  const el = $('#skillStatus');
  const btn = $('#skillInstallBtn');
  el.textContent = list
    .map((s) => `${s.installed ? (s.current ? '✓' : '⚠') : '✕'} ${s.name}`)
    .join(' · ') || '✕ no skills';
  const stale = list.filter((s) => !s.current);
  if (!stale.length) btn.classList.add('hidden');
  else {
    btn.textContent = stale.some((s) => !s.installed) ? 'Install' : 'Update';
    btn.classList.remove('hidden');
  }
}
$('#skillInstallBtn').addEventListener('click', async () => {
  const r = await api('/api/skill/install', { method: 'POST' });
  if (r.ok) renderSkillStatus();
  else $('#skillStatus').textContent = `✕ ${r.error || 'install failed'}`;
});

$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsCancelBtn').addEventListener('click', closeSettings);
$('#settingsBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSettings();
});
$('#logoutBtn').addEventListener('click', async () => {
  if (!(await confirmDlg('Sign out on this device? You will need the access token to get back in.', { confirmLabel: 'Sign out' }))) return;
  try { await fetch('/logout', { method: 'POST' }); } catch {}
  location.href = '/login';
});
$('#notifyTestBtn').addEventListener('click', async (e) => {
  // Save the current topic first so the test uses what's in the field.
  const f = $('#settingsForm');
  const r = await api('/api/settings', {
    method: 'PUT',
    body: { defaultCwd: f.defaultCwd.value, ntfyTopic: f.ntfyTopic.value, notifyMac: f.notifyMac.checked },
  });
  if (!r || r.error) return;
  state.config.settings = r;
  await api('/api/notify/test', { method: 'POST' });
  e.target.textContent = '🔔 Sent — check your phone';
  setTimeout(() => { e.target.textContent = '🔔 Test notification'; }, 3000);
});

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await api('/api/settings', {
    method: 'PUT',
    body: {
      defaultCwd: f.defaultCwd.value,
      defaultPermissionMode: f.defaultPermissionMode.value,
      reposDir: f.reposDir.value,
      ntfyTopic: f.ntfyTopic.value,
      notifyMac: f.notifyMac.checked,
      keepAwake: f.keepAwake.checked,
      archiveDays: parseInt(f.archiveDays.value, 10),
      prWatchMin: parseInt(f.prWatchMin.value, 10) || 0,
      prWatchAutoFix: f.prWatchAutoFix.checked,
      usageBudgetM: parseFloat(f.usageBudgetM.value) || 0,
    },
  });
  if (!r || r.error) return;
  state.config.settings = r;
  const c = await api('/api/config'); // re-scan repos for the picker
  if (!c || c.error) return;
  state.config = c;
  closeSettings(true);
});
