/* Kungfu Kanban frontend */
const COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'queued', label: 'Queued' },
  { key: 'running', label: 'Running' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];
// statuses that render inside the "running" column
const RUNNING_LIKE = { running: 1, stopping: 1 };

let config = { models: [], efforts: [], permissionModes: [], skills: [], agents: [], settings: {} };
let tasks = [];
let editingId = null;
let drawerId = null;

const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; return {}; }
  return res.json();
};

// ---------- board ----------
function render() {
  const board = $('#board');
  board.innerHTML = '';
  board.classList.toggle('is-empty', !tasks.length);

  updateHeaderStatus();

  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'dojo-empty';
    empty.innerHTML = `
      <h3>The dojo is quiet</h3>
      <p>Write a card, pick a model and effort, and let an agent train on it. Results land in Review.</p>`;
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = '＋ First card';
    btn.addEventListener('click', () => openModal(null));
    empty.appendChild(btn);
    board.appendChild(empty);
    return;
  }

  for (const col of COLUMNS) {
    const colTasks = tasks
      .filter((t) => (col.key === 'running' ? RUNNING_LIKE[t.status] : t.status === col.key))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const el = document.createElement('div');
    el.className = 'column';
    el.dataset.status = col.key;
    el.innerHTML = `
      <div class="col-head"><span class="col-name">${col.label}</span><span class="col-count">${colTasks.length}</span></div>
      <div class="col-body"></div>`;
    const body = el.querySelector('.col-body');
    if (!colTasks.length) body.innerHTML = '<div class="empty-col">—</div>';
    for (const t of colTasks) body.appendChild(cardEl(t));

    if (col.key !== 'running') {
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        const t = tasks.find((x) => x.id === id);
        if (!t || RUNNING_LIKE[t.status]) return;
        if (col.key === 'queued') {
          await api(`/api/tasks/${id}/run`, { method: 'POST' });
        } else {
          await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: col.key } });
        }
      });
    }
    board.appendChild(el);
  }
}

function updateHeaderStatus() {
  const counts = { backlog: 0, queued: 0, running: 0, stopping: 0, review: 0, done: 0 };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const running = counts.running + counts.stopping;
  $('#countBacklog').textContent = counts.backlog + counts.queued;
  $('#countRunning').textContent = running;
  $('#countReview').textContent = counts.review;
  $('#countDone').textContent = counts.done;
  const antenna = $('#antenna');
  antenna.classList.toggle('lit', running > 0);
  antenna.setAttribute('aria-label', running > 0 ? `${running} agent${running > 1 ? 's' : ''} running` : 'No agents running');
}

function cardEl(t) {
  const el = document.createElement('div');
  const isRunning = RUNNING_LIKE[t.status];
  el.className = 'card'
    + (isRunning ? ' running-card brush' : '')
    + (t.status === 'done' ? ' done-card' : '')
    + (t.error && t.status === 'review' ? ' failed-card' : '');
  el.draggable = !isRunning;
  el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', t.id));
  el.addEventListener('click', () => openDrawer(t.id));

  const meta = [];
  if (t.priority >= 2) meta.push(`<span class="prio-high" title="P${t.priority}"></span>`);
  if (t.createdBy === 'manager') meta.push('<span class="badge wt">sensei</span>');
  if (t.createdBy === 'import') meta.push('<span class="badge">import</span>');
  if (t.createdBy === 'auto') meta.push('<span class="badge skillauto">auto-fix</span>');
  if (t.createdBy === 'schedule') meta.push('<span class="badge sched">⏱ scheduled run</span>');
  meta.push(`<span class="badge model">${esc(t.model || 'default')}</span>`);
  if (t.effort && t.effort !== 'default') meta.push(`<span class="badge">${esc(t.effort)}</span>`);
  if (t.agent) meta.push(`<span class="badge">agent:${esc(t.agent)}</span>`);
  if (t.worktree) meta.push('<span class="badge wt">worktree</span>');
  if (t.issueNumber) meta.push(`<span class="badge">#${t.issueNumber}</span>`);
  if (t.schedule) meta.push(`<span class="badge sched">⏱ ${esc(scheduleLabel(t.schedule))}</span>`);
  if (t.skillsAuto) meta.push('<span class="badge skillauto">✦ auto</span>');
  for (const s of (t.skills || []).slice(0, 3)) meta.push(`<span class="badge">${esc(s)}</span>`);
  if ((t.skills || []).length > 3) meta.push(`<span class="badge">+${t.skills.length - 3}</span>`);
  if (t.prUrl) meta.push(`<a class="pr-link" href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR ↗</a>`);
  if (t.error && t.status !== 'done') meta.push(`<span class="failword">${t.error === 'Stopped by user' ? 'stopped' : 'failed'}</span>`);
  if (isRunning) {
    meta.push('<span class="runword">training…</span>');
    if (t.liveOut) meta.push(`<span class="badge">${fmtTok(t.liveOut)} out</span>`);
    if (t.ctxTokens) meta.push(`<span class="badge" title="Session context used (of ~200k)">ctx ${Math.round(t.ctxTokens / 2000)}%</span>`);
  } else if (t.stats && t.stats.turns) meta.push(`<span class="badge">${t.stats.turns} turns</span>`);

  const antenna = isRunning ? '<span class="antenna lit"></span>' : '';
  const seal = t.status === 'done' ? '<span class="seal card-seal seal--stamp">Shipped</span>' : '';
  // one quick action per column: Backlog ▶ run · Queued ⏸ unqueue ·
  // Review ✓ approve · Done ✕ delete (Running gets none — Stop is in the drawer)
  let quick = '';
  if (t.status === 'backlog') quick = '<button class="card-run" data-act="run" title="Run now" aria-label="Run now">▶</button>';
  else if (t.status === 'queued') quick = '<button class="card-run card-unq" data-act="unqueue" title="Pull back to Backlog (unqueue)" aria-label="Unqueue">⏸</button>';
  else if (t.status === 'review') quick = '<button class="card-run card-ok" data-act="approve" title="Approve — stamp it Done" aria-label="Approve">✓</button>';
  else if (t.status === 'done') quick = '<button class="card-run card-del" data-act="delete" title="Delete card" aria-label="Delete card">✕</button>';
  el.innerHTML = `${seal}<div class="card-top"><div class="title">${antenna}${esc(t.title)}</div>${quick}</div><div class="meta">${meta.join('')}</div>`;
  const pr = el.querySelector('.pr-link');
  if (pr) pr.addEventListener('click', (e) => e.stopPropagation());
  const qb = el.querySelector('.card-run');
  if (qb) qb.addEventListener('click', async (e) => {
    e.stopPropagation();
    const act = qb.dataset.act;
    if (act === 'run') api(`/api/tasks/${t.id}/run`, { method: 'POST' });
    else if (act === 'unqueue') api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'backlog' } });
    else if (act === 'approve') api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
    else if (act === 'delete') {
      if (!confirm('Delete this card?')) return;
      await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
    }
  });
  return el;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Schedule is a normalized object from the server: {kind:'interval',hours} or
// {kind:'daily',time}. Render it for the card badge and back into the "repeat"
// input's freeform form.
function scheduleLabel(sc) {
  if (!sc) return '';
  if (sc.kind === 'interval') return `every ${sc.hours}h`;
  if (sc.kind === 'daily') return `daily ${sc.time}`;
  return '';
}
function scheduleToInput(sc) {
  if (!sc) return '';
  if (sc.kind === 'interval') return `${sc.hours}h`;
  if (sc.kind === 'daily') return sc.time;
  return '';
}

// ---------- card modal ----------
function openModal(task) {
  editingId = task ? task.id : null;
  $('#modalTitle').textContent = task ? 'Edit card' : 'New card';
  const f = $('#taskForm');
  f.title.value = task ? task.title : '';
  f.prompt.value = task ? task.prompt : '';
  f.cwd.value = task ? task.cwd : config.settings.defaultCwd || '';

  // repo picker fills the cwd input; the input stays the source of truth
  const rs = $('#repoSelect');
  rs.innerHTML = '<option value="">repo…</option>';
  for (const r of config.repos || []) {
    const opt = document.createElement('option');
    opt.value = r.path;
    opt.textContent = r.name;
    rs.appendChild(opt);
  }
  rs.value = (config.repos || []).some((r) => r.path === f.cwd.value) ? f.cwd.value : '';
  rs.onchange = () => { if (rs.value) f.cwd.value = rs.value; };
  f.cwd.oninput = () => { rs.value = (config.repos || []).some((r) => r.path === f.cwd.value) ? f.cwd.value : ''; };
  fillSelect(f.model, config.models, task ? task.model : 'default');
  fillSelect(f.effort, config.efforts, task ? task.effort : 'default');
  fillSelect(f.permissionMode, config.permissionModes, task ? task.permissionMode : 'acceptEdits');
  const agentOpts = ['', ...config.agents.map((a) => a.name)];
  fillSelect(f.agent, agentOpts, task && task.agent ? task.agent : '');
  f.worktree.checked = task ? !!task.worktree : false;
  f.openPr.checked = task ? !!task.openPr : false;
  f.priority.value = String(task && task.priority ? task.priority : 0);
  f.acceptanceCriteria.value = task ? task.acceptanceCriteria || '' : '';
  f.schedule.value = task ? scheduleToInput(task.schedule) : '';

  const picker = $('#skillPicker');
  picker.innerHTML = '';
  const auto = document.createElement('span');
  // new cards default to auto-select; editing reflects the card's saved choice
  auto.className = 'skill-chip auto' + ((task ? task.skillsAuto : true) ? ' on' : '');
  auto.textContent = '✦ auto-select';
  auto.title = 'Let the agent pick relevant skills itself';
  auto.dataset.auto = '1';
  auto.addEventListener('click', () => auto.classList.toggle('on'));
  picker.appendChild(auto);
  const selected = new Set(task ? task.skills || [] : []);
  for (const s of config.skills) {
    const chip = document.createElement('span');
    chip.className = 'skill-chip' + (selected.has(s.name) ? ' on' : '');
    chip.textContent = s.name;
    chip.title = s.description || '';
    chip.dataset.name = s.name;
    chip.addEventListener('click', () => chip.classList.toggle('on'));
    picker.appendChild(chip);
  }
  $('#modalBackdrop').classList.remove('hidden');
  f.title.focus();
}

function fillSelect(sel, opts, value) {
  sel.innerHTML = '';
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o === '' ? '(none)' : o;
    sel.appendChild(opt);
  }
  sel.value = value || opts[0] || '';
}

$('#taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
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
    schedule: f.schedule.value,
    skills: [...document.querySelectorAll('.skill-chip.on')].filter((c) => !c.dataset.auto).map((c) => c.dataset.name),
    skillsAuto: !!document.querySelector('.skill-chip.auto.on'),
  };
  if (editingId) await api(`/api/tasks/${editingId}`, { method: 'PATCH', body });
  else await api('/api/tasks', { method: 'POST', body });
  $('#modalBackdrop').classList.add('hidden');
  await loadTasks();
});

$('#newTaskBtn').addEventListener('click', () => openModal(null));
$('#cancelBtn').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
$('#modalBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#modalBackdrop').classList.add('hidden');
});

// ---------- import modal ----------
let draftSessionId = null;

$('#importBtn').addEventListener('click', () => {
  $('#importResult').textContent = '';
  draftSessionId = null;
  $('#refineRow').classList.add('hidden');
  const dr = $('#draftRepo');
  dr.innerHTML = '<option value="">repo…</option>';
  for (const r of config.repos || []) {
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
$('#importCancelBtn').addEventListener('click', () => $('#importBackdrop').classList.add('hidden'));
$('#importBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#importBackdrop').classList.add('hidden');
});
async function runDraft(btn, busyLabel, idleLabel, body) {
  btn.disabled = true;
  btn.textContent = busyLabel;
  const r = await api('/api/import/draft', { method: 'POST', body });
  btn.disabled = false;
  btn.textContent = idleLabel;
  if (r.markdown) {
    $('#importText').value = r.markdown;
    draftSessionId = r.sessionId || draftSessionId;
    $('#refineRow').classList.toggle('hidden', !draftSessionId);
    $('#importResult').textContent = '✓ draft ready — review, edit (or ↻ refine), then Import';
    updatePreview();
  } else {
    $('#importResult').textContent = `✕ ${r.error || 'draft failed'}`;
  }
}

$('#draftBtn').addEventListener('click', (e) => {
  const request = $('#draftPrompt').value.trim();
  if (!request) return;
  const explore = $('#exploreToggle').checked;
  runDraft(e.target, explore ? '✨ exploring & drafting…' : '✨ drafting…', '✨ Draft', {
    request,
    repoPath: $('#draftRepo').value || null,
    explore,
  });
});

$('#refineBtn').addEventListener('click', (e) => {
  const msg = $('#refinePrompt').value.trim();
  if (!msg || !draftSessionId) return;
  $('#refinePrompt').value = '';
  runDraft(e.target, '↻ refining…', '↻ Refine', { refine: msg, sessionId: draftSessionId });
});

$('#issuesBtn').addEventListener('click', async (e) => {
  const repoPath = $('#draftRepo').value;
  if (!repoPath) { $('#importResult').textContent = '✕ pick a repo first'; return; }
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '⇣ fetching…';
  const r = await api('/api/import/issues', { method: 'POST', body: { repoPath } });
  btn.disabled = false;
  btn.textContent = '⇣ From issues';
  if (r.error) $('#importResult').textContent = `✕ ${r.error}`;
  else if (!r.count) $('#importResult').textContent = 'no open issues in that repo';
  else {
    $('#importText').value = r.markdown;
    $('#importResult').textContent = `✓ ${r.count} issue${r.count === 1 ? '' : 's'} → review, then Import (PRs will say Fixes #N)`;
    updatePreview();
  }
});

$('#fmtExample').addEventListener('click', async (e) => {
  const pre = e.currentTarget;
  try {
    await navigator.clipboard.writeText(pre.textContent);
    $('#importResult').textContent = '✓ template copied';
  } catch {
    $('#importResult').textContent = '✕ copy blocked by browser';
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
$('#importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const md = $('#importText').value;
  if (!md.trim()) return;
  const r = await api('/api/import', { method: 'POST', body: { markdown: md } });
  const out = $('#importResult');
  if (r.error) {
    out.textContent = `✕ ${r.error}`;
  } else if (!r.created) {
    out.textContent = '✕ no cards found — need ## headings or - [ ] items';
  } else {
    out.textContent = `✓ ${r.created} card${r.created === 1 ? '' : 's'} created`;
    $('#importText').value = '';
    $('#importFile').value = '';
    await loadTasks();
    setTimeout(() => $('#importBackdrop').classList.add('hidden'), 900);
  }
});

// ---------- settings modal ----------
function openSettings() {
  const f = $('#settingsForm');
  f.defaultCwd.value = config.settings.defaultCwd || '';
  f.reposDir.value = config.settings.reposDir || '';
  f.ntfyTopic.value = config.settings.ntfyTopic || '';
  f.notifyMac.checked = config.settings.notifyMac !== false;
  f.archiveDays.value = config.settings.archiveDays ?? 7;
  f.prWatchMin.value = Number.isInteger(config.settings.prWatchMin) ? config.settings.prWatchMin : 10;
  f.prWatchAutoFix.checked = config.settings.prWatchAutoFix !== false;
  f.usageBudgetM.value = (config.settings.usageBudgetTokens || 0) / 1_000_000;
  renderUsage();
  renderSkillStatus();
  $('#settingsBackdrop').classList.remove('hidden');
}
async function renderSkillStatus() {
  const s = await api('/api/skill');
  const el = $('#skillStatus');
  const btn = $('#skillInstallBtn');
  if (s.installed && s.current) {
    el.textContent = '✓ installed & up to date';
    btn.classList.add('hidden');
  } else if (s.installed) {
    el.textContent = '⚠ installed, update available';
    btn.textContent = 'Update';
    btn.classList.remove('hidden');
  } else {
    el.textContent = '✕ not installed';
    btn.textContent = 'Install';
    btn.classList.remove('hidden');
  }
}
$('#skillInstallBtn').addEventListener('click', async () => {
  const r = await api('/api/skill/install', { method: 'POST' });
  $('#skillStatus').textContent = r.ok ? '✓ installed & up to date' : `✕ ${r.error || 'install failed'}`;
  if (r.ok) $('#skillInstallBtn').classList.add('hidden');
});

$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsCancelBtn').addEventListener('click', () => $('#settingsBackdrop').classList.add('hidden'));
$('#settingsBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#settingsBackdrop').classList.add('hidden');
});
$('#notifyTestBtn').addEventListener('click', async (e) => {
  // Save the current topic first so the test uses what's in the field.
  const f = $('#settingsForm');
  config.settings = await api('/api/settings', {
    method: 'PUT',
    body: { defaultCwd: f.defaultCwd.value, ntfyTopic: f.ntfyTopic.value, notifyMac: f.notifyMac.checked },
  });
  await api('/api/notify/test', { method: 'POST' });
  e.target.textContent = '🔔 Sent — check your phone';
  setTimeout(() => { e.target.textContent = '🔔 Test notification'; }, 3000);
});

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  config.settings = await api('/api/settings', {
    method: 'PUT',
    body: {
      defaultCwd: f.defaultCwd.value,
      reposDir: f.reposDir.value,
      ntfyTopic: f.ntfyTopic.value,
      notifyMac: f.notifyMac.checked,
      archiveDays: parseInt(f.archiveDays.value, 10),
      prWatchMin: parseInt(f.prWatchMin.value, 10) || 0,
      prWatchAutoFix: f.prWatchAutoFix.checked,
      usageBudgetM: parseFloat(f.usageBudgetM.value) || 0,
    },
  });
  config = await api('/api/config'); // re-scan repos for the picker
  $('#settingsBackdrop').classList.add('hidden');
});

// ---------- subscription cooldown + model fallback chips ----------
let cooldownUntil = 0;
let modelBlocks = {};
function applyCooldown(until) {
  cooldownUntil = until || 0;
  tickCooldown();
}
function applyModelBlocks(blocks) {
  modelBlocks = blocks || {};
  tickCooldown();
}
function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
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
function paintThemeToggle() {
  const light = document.documentElement.dataset.theme === 'light';
  const btn = $('#themeToggle');
  btn.textContent = light ? '☾' : '☀';
  btn.title = light ? 'Enter the night dojo' : 'Enter the day dojo';
}
$('#themeToggle').addEventListener('click', () => {
  const next = !(document.documentElement.dataset.theme === 'light');
  if (next) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('kk-theme', next ? 'light' : 'dark'); } catch {}
  paintThemeToggle();
});
paintThemeToggle();

// ---------- drawer ----------
async function openDrawer(id) {
  drawerId = id;
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  $('#drawerTitle').textContent = t.title;
  renderDrawerMeta(t);
  renderDrawerActions(t);
  const entries = await api(`/api/tasks/${id}/transcript`);
  const box = $('#transcript');
  box.innerHTML = '';
  for (const e of entries) box.appendChild(entryEl(e));
  if (t.error) box.appendChild(entryEl({ kind: 'error', text: t.error }));
  box.classList.toggle('hidden', !box.children.length && !RUNNING_LIKE[t.status]);
  $('#followForm').classList.toggle('hidden', RUNNING_LIKE[t.status] || !t.sessionId);

  // the work: prompt shown and editable right here
  const pe = $('#promptEdit');
  pe.value = t.prompt || '';
  pe.disabled = !!RUNNING_LIKE[t.status];
  $('#promptSaveBtn').classList.add('hidden');

  $('#drawer').classList.remove('hidden');
  box.scrollTop = box.scrollHeight;
}

$('#promptEdit').addEventListener('input', () => {
  const t = tasks.find((x) => x.id === drawerId);
  $('#promptSaveBtn').classList.toggle('hidden', !t || $('#promptEdit').value === t.prompt);
});
$('#promptSaveBtn').addEventListener('click', async () => {
  if (!drawerId) return;
  const r = await api(`/api/tasks/${drawerId}`, { method: 'PATCH', body: { prompt: $('#promptEdit').value } });
  if (!r.error) $('#promptSaveBtn').classList.add('hidden');
});

$('#followForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.message;
  const msg = input.value.trim();
  if (!msg || !drawerId) return;
  input.value = '';
  const r = await api(`/api/tasks/${drawerId}/followup`, { method: 'POST', body: { message: msg } });
  if (r.error) {
    const box = $('#transcript');
    box.appendChild(entryEl({ kind: 'error', text: r.error }));
    box.scrollTop = box.scrollHeight;
  }
});

function renderDrawerMeta(t) {
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
  mkSel('model', config.models, t.model, 'model');
  mkSel('effort', config.efforts, t.effort, 'effort');

  const bits = [`perms: ${t.permissionMode}`, `cwd: ${t.cwd}`];
  if (t.ctxTokens) bits.push(`ctx: ${fmtTok(t.ctxTokens)} (${Math.round(t.ctxTokens / 2000)}% of 200k)`);
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
    box.appendChild(span);
  }
  if (t.sessionId) {
    const cmd = `claude -r ${t.sessionId}`;
    const b = document.createElement('span');
    b.className = 'badge copyable';
    b.title = 'Click to copy the resume command';
    b.textContent = `resume: ${cmd}`;
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        b.textContent = '✓ copied';
      } catch {
        b.textContent = '✕ copy blocked';
      }
      setTimeout(() => { b.textContent = `resume: ${cmd}`; }, 1200);
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

function renderDrawerActions(t) {
  const box = $('#drawerActions');
  box.innerHTML = '';
  const mk = (label, cls, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    box.appendChild(b);
  };
  if (RUNNING_LIKE[t.status]) {
    mk('⏹ Stop', 'danger', 'Stop the agent (SIGTERM; the partial transcript is kept)', () => api(`/api/tasks/${t.id}/stop`, { method: 'POST' }));
  } else {
    mk('▶ Run', 'primary', 'Launch now — re-running clears the previous transcript and result', () => {
      if (t.resultText && !confirm('Re-running clears the previous transcript and result. Continue?')) return;
      api(`/api/tasks/${t.id}/run`, { method: 'POST' });
    });
    mk('Edit', 'ghost', 'Edit the card (prompt, model, schedule, …)', () => { $('#drawer').classList.add('hidden'); openModal(t); });
    if (t.status === 'review') mk('✓ Done', '', 'Stamp it shipped — moves the card to Done', async () => {
      await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
      $('#drawer').classList.add('hidden');
    });
    if (t.prUrl && t.status !== 'done') {
      mk('⇉ Merge PR', '', 'Merge the pull request on GitHub (merge commit) and stamp the card Done', async () => {
        if (!confirm(`Merge this PR?\n${t.prUrl}`)) return;
        const r = await api(`/api/tasks/${t.id}/pr`, { method: 'POST', body: { action: 'merge' } });
        if (r.error) alert(`Merge failed: ${r.error}`);
      });
      mk('Close PR', 'ghost', 'Close the pull request on GitHub without merging (the branch and work remain)', async () => {
        if (!confirm(`Close this PR without merging?\n${t.prUrl}`)) return;
        const r = await api(`/api/tasks/${t.id}/pr`, { method: 'POST', body: { action: 'close' } });
        if (r.error) alert(`Close failed: ${r.error}`);
      });
    }
    mk('Delete', 'danger', 'Delete the card and its transcript (does not touch git or PRs)', async () => {
      if (!confirm('Delete this card?')) return;
      await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
      $('#drawer').classList.add('hidden');
      await loadTasks();
    });
  }
}

function entryEl(e) {
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

// ---------- tiny markdown renderer (headings, bold/italic, inline code, fences, lists, links) ----------
function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  return s;
}

function mdToHtml(raw) {
  const blocks = [];
  const text = esc(raw).replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/^\n/, '')}</code></pre>`);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });

  const lines = text.split('\n');
  const out = [];
  let listType = null;
  let para = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    const blockMatch = line.trim().match(/^\x00BLOCK(\d+)\x00$/);
    if (blockMatch) {
      flushPara(); closeList();
      out.push(blocks[Number(blockMatch[1])]);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${mdInline(ol[1])}</li>`);
      continue;
    }
    if (ul) {
      flushPara();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${mdInline(ul[1])}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara(); closeList();
      continue;
    }
    para.push(line);
  }
  flushPara(); closeList();

  return out.join('\n');
}

$('#drawerClose').addEventListener('click', () => { $('#drawer').classList.add('hidden'); drawerId = null; });

// ---------- manager tab ----------
let mgrState = null;

function showTab(which) {
  $('#board').classList.toggle('hidden', which !== 'board');
  $('#boardToolbar').classList.toggle('hidden', which !== 'board');
  $('#managerView').classList.toggle('hidden', which !== 'manager');
  $('#tabBoard').classList.toggle('active', which === 'board');
  $('#tabManager').classList.toggle('active', which === 'manager');
  if (which === 'manager') loadManager();
}
$('#tabBoard').addEventListener('click', () => showTab('board'));
$('#tabManager').addEventListener('click', () => showTab('manager'));

async function loadManager() {
  mgrState = await api('/api/manager');
  renderManager();
}

function renderManager() {
  if (!mgrState) return;
  const c = mgrState.config;
  const f = $('#mgrForm');
  f.enabled.checked = !!c.enabled;
  fillSelect(f.model, config.models, c.model);
  fillSelect(f.effort, config.efforts, c.effort);
  f.autonomy.value = c.autonomy;
  f.stylePrompt.value = c.stylePrompt || '';
  f.onFinish.checked = !!c.triggers.onFinish;
  f.onNewCard.checked = !!c.triggers.onNewCard;
  f.intervalMin.value = c.triggers.intervalMin || 0;
  f.maxLaunchesPerHour.value = c.maxLaunchesPerHour;
  f.maxRetries.value = c.maxRetries;
  fillSelect(f.permissionCeiling, config.permissionModes, c.permissionCeiling);

  $('#mgrBusy').classList.toggle('hidden', !mgrState.busy);

  // chat
  const chat = $('#mgrChat');
  chat.innerHTML = '';
  for (const m of mgrState.chat) {
    const div = document.createElement('div');
    div.className = `chat-msg ${m.role}`;
    div.textContent = m.text;
    chat.appendChild(div);
  }
  chat.scrollTop = chat.scrollHeight;

  // suggestions
  const sug = $('#mgrSuggestions');
  sug.innerHTML = '';
  if (!mgrState.suggestions.length) sug.innerHTML = '<div class="empty-col">nothing pending</div>';
  for (const s of mgrState.suggestions) {
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
    ok.addEventListener('click', async () => {
      await api(`/api/manager/suggestions/${s.id}`, { method: 'POST', body: { approve: true } });
      await Promise.all([loadManager(), loadTasks()]);
    });
    const no = document.createElement('button');
    no.className = 'danger';
    no.textContent = '✗ Reject';
    no.addEventListener('click', async () => {
      await api(`/api/manager/suggestions/${s.id}`, { method: 'POST', body: { approve: false } });
      await loadManager();
    });
    actions.append(ok, no);
    div.append(head, why, actions);
    sug.appendChild(div);
  }
  const pill = $('#suggCount');
  pill.textContent = mgrState.suggestions.length;
  pill.classList.toggle('hidden', !mgrState.suggestions.length);

  // log
  const logBox = $('#mgrLog');
  logBox.innerHTML = '';
  for (const e of mgrState.log) {
    const div = document.createElement('div');
    div.className = `log-entry ${e.kind}`;
    div.textContent = `${new Date(e.ts).toLocaleTimeString()} · ${e.kind} · ${e.text}`;
    logBox.appendChild(div);
  }
}

function describeAction(a) {
  switch (a.type) {
    case 'create_task': return `Create "${a.title}" [${a.model || 'default'}/${a.effort || 'default'}]${a.autoRun ? ' and run' : ''}`;
    case 'update_task': return `Update task ${taskTitle(a.taskId)}`;
    case 'run_task': return `Run ${taskTitle(a.taskId)}`;
    case 'approve_task': return `Approve ${taskTitle(a.taskId)} → Done`;
    case 'reject_task': return `Retry ${taskTitle(a.taskId)} with feedback: ${(a.feedback || '').slice(0, 100)}`;
    default: return a.type;
  }
}
function taskTitle(id) {
  const t = tasks.find((x) => x.id === id);
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
  await loadManager();
});

$('#clearChatBtn').addEventListener('click', async () => {
  if (!confirm('Clear the Sensei chat history?')) return;
  await api('/api/manager/clear', { method: 'POST', body: { chat: true } });
  await loadManager();
});
$('#clearLogBtn').addEventListener('click', async () => {
  if (!confirm('Clear the activity log?')) return;
  await api('/api/manager/clear', { method: 'POST', body: { log: true } });
  await loadManager();
});

$('#mgrChatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.message;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  await api('/api/manager/chat', { method: 'POST', body: { message: msg } });
  await loadManager();
});

// ---------- live updates ----------
const es = new EventSource('/api/events');
es.onmessage = (msg) => {
  const evt = JSON.parse(msg.data);
  if (evt.type === 'cooldown') {
    applyCooldown(evt.until);
    return;
  }
  if (evt.type === 'modelblocks') {
    applyModelBlocks(evt.blocks);
    return;
  }
  if (evt.type === 'manager') {
    if (evt.event === 'busy' && mgrState) {
      mgrState.busy = evt.busy;
      $('#mgrBusy').classList.toggle('hidden', !evt.busy);
      if (!evt.busy) loadManager();
    } else if (!$('#managerView').classList.contains('hidden')) {
      loadManager();
    } else if (evt.event === 'suggestions') {
      loadManager(); // keep the badge count fresh even on the board tab
    }
    return;
  }
  if (evt.type === 'task') {
    const i = tasks.findIndex((t) => t.id === evt.task.id);
    if (i >= 0) tasks[i] = evt.task; else tasks.unshift(evt.task);
    render();
    if (drawerId === evt.task.id) {
      renderDrawerMeta(evt.task);
      renderDrawerActions(evt.task);
      $('#followForm').classList.toggle('hidden', !!RUNNING_LIKE[evt.task.status] || !evt.task.sessionId);
      $('#promptEdit').disabled = !!RUNNING_LIKE[evt.task.status];
    }
  } else if (evt.type === 'deleted') {
    tasks = tasks.filter((t) => t.id !== evt.taskId);
    render();
  } else if (evt.type === 'output' && drawerId === evt.taskId) {
    const box = $('#transcript');
    box.appendChild(entryEl(evt.entry));
    box.scrollTop = box.scrollHeight;
  }
};

// ---------- settings ----------
$('#maxConcurrent').addEventListener('change', async (e) => {
  config.settings = await api('/api/settings', { method: 'PUT', body: { maxConcurrent: parseInt(e.target.value, 10) } });
});

// ---------- init ----------
async function loadTasks() {
  tasks = await api('/api/tasks');
  render();
}
// ---------- 5-hour usage chip ----------
function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

async function renderUsage() {
  const u = await api('/api/usage');
  if (!u || u.output === undefined) return;
  const chip = $('#usageChip');
  const txt = $('#usageChipText');
  if (u.budgetTokens > 0) {
    const pct = Math.round((u.output / u.budgetTokens) * 100);
    txt.textContent = `5h ${pct}%`;
    chip.classList.toggle('warn', pct >= 70 && pct < 90);
    chip.classList.toggle('bad', pct >= 90);
  } else {
    txt.textContent = `5h ${fmtTok(u.output)}`;
    chip.classList.remove('warn', 'bad');
  }
  chip.classList.remove('hidden');
  const bd = $('#usageBreakdown');
  const models = Object.entries(u.byModel || {}).sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m} ${fmtTok(n)}`).join(' · ');
  bd.textContent = `last 5h across this Mac's Claude Code: ${fmtTok(u.output)} out / ${fmtTok(u.input)} in (${fmtTok(u.cacheRead)} cached) · ${u.turns} turns${models ? ` · ${models}` : ''}`;
}
setInterval(renderUsage, 5 * 60_000);

// ---------- system status (claude CLI + gh health) ----------
async function renderHealth() {
  const el = $('#sysStatus');
  const [h, v] = await Promise.all([api('/api/health'), api('/api/version')]);
  if (!h.claude) return; // auth redirect etc.
  const dot = (ok) => `<span class="sys-dot ${ok ? 'ok' : 'bad'}">●</span>`;
  const upBtn = h.claude.ok
    ? ' <button id="updateClaudeBtn" class="ghost mini" title="Update the Claude Code CLI in place (runs claude update)">↑ update</button>'
    : '';
  const boardVer = v && v.version
    ? `kungfu v${esc(v.version)}${v.behind > 0
      ? ` <button id="updateBoardBtn" class="ghost mini warn" title="Your clone is ${v.behind} commit${v.behind > 1 ? 's' : ''} behind origin — pulls fast-forward and restarts the board">⬆ ${v.remoteVersion ? `v${esc(v.remoteVersion)}` : 'update'} available</button>`
      : ''} · `
    : '';
  if (h.claude.ok && h.gh.ok) {
    el.innerHTML = `${boardVer}on your subscription · ${dot(true)} ${esc(h.claude.out || 'claude')}${upBtn} · ${dot(true)} gh`;
  } else {
    el.innerHTML = boardVer + [
      h.claude.ok ? `${dot(true)} ${esc(h.claude.out)}${upBtn}` : `${dot(false)} claude CLI not working — cards can't run`,
      h.gh.ok ? `${dot(true)} gh` : `${dot(false)} gh not authed — PR features off`,
    ].join(' · ');
  }
  const bb = $('#updateBoardBtn');
  if (bb) bb.addEventListener('click', async () => {
    if (!confirm('Update the board to the latest code? It pulls from origin and restarts itself (blocked while cards are running). Under plain `npm start` the server stops instead — restart it after.')) return;
    bb.disabled = true;
    bb.textContent = '⬆ updating…';
    const r = await api('/api/system/update-board', { method: 'POST' });
    if (r.error) {
      alert(`Update failed: ${r.error}`);
      renderHealth();
      return;
    }
    bb.textContent = '⬆ restarting…';
    setTimeout(() => location.reload(), 6000);
  });
  const ub = $('#updateClaudeBtn');
  if (ub) ub.addEventListener('click', async () => {
    if (!confirm('Update the Claude Code CLI now? Running agents finish on the old version; new runs use the new one.')) return;
    ub.disabled = true;
    ub.textContent = '↑ updating…';
    const r = await api('/api/system/update-claude', { method: 'POST' });
    alert(r.ok ? (r.output || 'Updated.') : `Update failed: ${r.error || 'unknown error'}`);
    renderHealth();
  });
}

(async () => {
  config = await api('/api/config');
  $('#maxConcurrent').value = config.settings.maxConcurrent || 2;
  applyCooldown(config.cooldownUntil || 0);
  applyModelBlocks(config.modelBlocks || {});
  await loadTasks();
  renderHealth();
  renderUsage();
})();
