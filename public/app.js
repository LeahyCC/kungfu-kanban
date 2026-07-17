/* Claude Kanban frontend */
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
  return res.json();
};

// ---------- board ----------
function render() {
  const board = $('#board');
  board.innerHTML = '';
  for (const col of COLUMNS) {
    const colTasks = tasks.filter((t) =>
      col.key === 'running' ? RUNNING_LIKE[t.status] : t.status === col.key
    );
    const el = document.createElement('div');
    el.className = 'column';
    el.dataset.status = col.key;
    el.innerHTML = `
      <div class="col-head"><span>${col.label}</span><span class="count">${colTasks.length}</span></div>
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

function cardEl(t) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = !RUNNING_LIKE[t.status];
  el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', t.id));
  el.addEventListener('click', () => openDrawer(t.id));

  const badges = [];
  badges.push(`<span class="badge model">${esc(t.model || 'default')}</span>`);
  if (t.effort && t.effort !== 'default') badges.push(`<span class="badge effort">${esc(t.effort)}</span>`);
  if (t.agent) badges.push(`<span class="badge">agent:${esc(t.agent)}</span>`);
  if (t.worktree) badges.push(`<span class="badge wt">worktree</span>`);
  for (const s of (t.skills || []).slice(0, 3)) badges.push(`<span class="badge skill">${esc(s)}</span>`);
  if ((t.skills || []).length > 3) badges.push(`<span class="badge skill">+${t.skills.length - 3}</span>`);
  if (t.error) badges.push(`<span class="badge err">error</span>`);
  if (t.stats && t.stats.turns) badges.push(`<span class="badge">${t.stats.turns} turns</span>`);

  const spin = RUNNING_LIKE[t.status] ? '<span class="spin"></span>' : '';
  el.innerHTML = `<div class="title">${spin}${esc(t.title)}</div><div class="badges">${badges.join('')}</div>`;
  return el;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- modal ----------
function openModal(task) {
  editingId = task ? task.id : null;
  $('#modalTitle').textContent = task ? 'Edit task' : 'New task';
  const f = $('#taskForm');
  f.title.value = task ? task.title : '';
  f.prompt.value = task ? task.prompt : '';
  f.cwd.value = task ? task.cwd : config.settings.defaultCwd || '';
  fillSelect(f.model, config.models, task ? task.model : 'default');
  fillSelect(f.effort, config.efforts, task ? task.effort : 'default');
  fillSelect(f.permissionMode, config.permissionModes, task ? task.permissionMode : 'acceptEdits');
  const agentOpts = ['', ...config.agents.map((a) => a.name)];
  fillSelect(f.agent, agentOpts, task && task.agent ? task.agent : '');
  f.worktree.checked = task ? !!task.worktree : false;

  const picker = $('#skillPicker');
  picker.innerHTML = '';
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
    skills: [...document.querySelectorAll('.skill-chip.on')].map((c) => c.dataset.name),
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
  $('#drawer').classList.remove('hidden');
  box.scrollTop = box.scrollHeight;
}

function renderDrawerMeta(t) {
  const bits = [
    `model: ${t.modelUsed || t.model}`,
    `effort: ${t.effort}`,
    `perms: ${t.permissionMode}`,
    `cwd: ${t.cwd}`,
  ];
  if (t.skills && t.skills.length) bits.push(`skills: ${t.skills.join(', ')}`);
  if (t.stats) {
    if (t.stats.turns) bits.push(`${t.stats.turns} turns`);
    if (t.stats.durationMs) bits.push(`${Math.round(t.stats.durationMs / 1000)}s`);
    if (t.stats.outputTokens) bits.push(`${t.stats.inputTokens || 0} in / ${t.stats.outputTokens} out tok`);
  }
  if (t.sessionId) bits.push(`resume: claude -r ${t.sessionId}`);
  $('#drawerMeta').innerHTML = bits.map((b) => `<span class="badge">${esc(b)}</span>`).join('');
}

function renderDrawerActions(t) {
  const box = $('#drawerActions');
  box.innerHTML = '';
  const mk = (label, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    box.appendChild(b);
  };
  if (RUNNING_LIKE[t.status]) {
    mk('⏹ Stop', 'danger', () => api(`/api/tasks/${t.id}/stop`, { method: 'POST' }));
  } else {
    mk('▶ Run', 'primary', () => api(`/api/tasks/${t.id}/run`, { method: 'POST' }));
    mk('Edit', '', () => { $('#drawer').classList.add('hidden'); openModal(t); });
    if (t.status === 'review') mk('✓ Done', '', async () => {
      await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
      $('#drawer').classList.add('hidden');
    });
    mk('Delete', 'danger', async () => {
      if (!confirm('Delete this task?')) return;
      await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
      $('#drawer').classList.add('hidden');
      await loadTasks();
    });
  }
}

function entryEl(e) {
  const div = document.createElement('div');
  div.className = `t-entry ${e.kind}`;
  div.textContent = e.text;
  return div;
}

$('#drawerClose').addEventListener('click', () => { $('#drawer').classList.add('hidden'); drawerId = null; });

// ---------- live updates ----------
const es = new EventSource('/api/events');
es.onmessage = (msg) => {
  const evt = JSON.parse(msg.data);
  if (evt.type === 'task') {
    const i = tasks.findIndex((t) => t.id === evt.task.id);
    if (i >= 0) tasks[i] = evt.task; else tasks.unshift(evt.task);
    render();
    if (drawerId === evt.task.id) {
      renderDrawerMeta(evt.task);
      renderDrawerActions(evt.task);
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
  await api('/api/settings', { method: 'PUT', body: { maxConcurrent: parseInt(e.target.value, 10) } });
});

// ---------- init ----------
async function loadTasks() {
  tasks = await api('/api/tasks');
  render();
}
(async () => {
  config = await api('/api/config');
  $('#maxConcurrent').value = config.settings.maxConcurrent || 2;
  await loadTasks();
})();
