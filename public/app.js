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

// ---------- toasts: non-blocking error/status surface ----------
function toast(msg, kind = 'error', ms = 5000) {
  let holder = $('#toasts');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'toasts';
    document.body.appendChild(holder);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  t.textContent = msg;
  holder.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Every response is inspected; errors surface as a toast unless the call site
// renders them itself ({quiet: true}). Never returns a rejected promise.
const api = async (url, opts = {}) => {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    const error = `network error — ${e.message || e}`;
    if (!opts.quiet) toast(`✕ ${error}`);
    return { error };
  }
  if (res.status === 401) { location.href = '/login'; return {}; }
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok && !data.error) data.error = `request failed (${res.status})`;
  if (data.error && !opts.quiet) toast(`✕ ${data.error}`);
  return data;
};

// ---------- styled confirm/alert (replaces native dialogs) ----------
function showDialog({ text, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, alertOnly = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'kk-dialog';
    // resolve from the handlers themselves — some engines skip the dialog
    // 'close' event, which would leave this promise (and the UI) hanging
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      try { dlg.close(); } catch {}
      dlg.remove();
      resolve(val);
    };
    const p = document.createElement('p');
    p.textContent = text;
    const row = document.createElement('div');
    row.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.className = danger ? 'danger' : 'primary';
    ok.textContent = confirmLabel;
    ok.addEventListener('click', () => done(true));
    if (!alertOnly) {
      const no = document.createElement('button');
      no.className = 'ghost';
      no.textContent = cancelLabel;
      no.addEventListener('click', () => done(false));
      row.append(no);
    }
    row.append(ok);
    dlg.append(p, row);
    dlg.addEventListener('cancel', () => done(false)); // Escape
    dlg.addEventListener('close', () => done(false));  // any other native close
    document.body.appendChild(dlg);
    dlg.showModal();
    ok.focus();
  });
}
const confirmDlg = (text, opts = {}) => showDialog({ text, ...opts });
const alertDlg = (text) => showDialog({ text, alertOnly: true });

// disable a control while its async action runs (double-submit guard)
async function withBusy(el, fn) {
  if (!el || el.disabled) return;
  el.disabled = true;
  try { return await fn(); } finally { el.disabled = false; }
}

// auto-scroll only when the reader is already pinned near the bottom
const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 60;

function relTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---------- board ----------
// Rebuilding mid-drag kills the drag; defer renders until it ends. Column
// scroll positions are restored across rebuilds.
let draggingNow = false;
let renderQueued = false;
let filterText = '';

function matchesFilter(t) {
  if (!filterText) return true;
  const hay = [t.title, t.prompt, t.cwd, t.model, t.agent, ...(t.skills || [])]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(filterText);
}

function render() {
  if (draggingNow) { renderQueued = true; return; }
  const board = $('#board');
  const scrolls = {};
  for (const c of board.querySelectorAll('.column')) {
    scrolls[c.dataset.status] = c.querySelector('.col-body').scrollTop;
  }
  board.innerHTML = '';
  board.classList.toggle('is-empty', !tasks.length);

  updateHeaderStatus();

  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'dojo-empty';
    empty.innerHTML = `
      <h3>The dojo is quiet</h3>
      <p>Cards create themselves — say the word in any Claude Code session and the board
        drafts, imports, and triages them. Results land in Review.</p>
      <div class="empty-prompt" title="The kungfu-todo skill is auto-installed for every Claude Code session on this machine">
        <span class="c">$ claude</span>
        <span>&raquo; create a kungfu todo for: fix the flaky auth test, then add a healthcheck endpoint</span>
      </div>
      <p class="empty-sub">Or ⇪ Import: paste a plan, ✨ describe the work and the Sensei writes the
        cards, or pull your open GitHub issues.</p>`;
    const actions = document.createElement('div');
    actions.className = 'empty-actions';
    const imp = document.createElement('button');
    imp.className = 'primary';
    imp.textContent = '⇪ Import / draft cards';
    imp.addEventListener('click', () => $('#importBtn').click());
    const manual = document.createElement('button');
    manual.className = 'ghost';
    manual.textContent = '＋ Write one by hand';
    manual.addEventListener('click', () => openModal(null));
    actions.append(imp, manual);
    empty.appendChild(actions);
    board.appendChild(empty);
    return;
  }

  for (const col of COLUMNS) {
    const colTasks = tasks
      .filter(matchesFilter)
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
      // depth counter: dragleave fires when crossing into child cards, which
      // used to strobe the outline
      let dragDepth = 0;
      el.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; el.classList.add('drag-over'); });
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('dragleave', () => {
        if (--dragDepth <= 0) { dragDepth = 0; el.classList.remove('drag-over'); }
      });
      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragDepth = 0;
        el.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        const t = tasks.find((x) => x.id === id);
        if (!t || RUNNING_LIKE[t.status] || t.status === col.key) return;
        if (col.key === 'done'
          && !(await confirmDlg(`Mark "${t.title}" as Done? No run happens — the card just ships.`, { confirmLabel: '✓ Ship it' }))) return;
        if (col.key === 'queued') {
          await api(`/api/tasks/${id}/run`, { method: 'POST' });
        } else {
          await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: col.key } });
        }
      });
    }
    board.appendChild(el);
    const body2 = el.querySelector('.col-body');
    if (scrolls[col.key]) body2.scrollTop = scrolls[col.key];
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

// The SHIPPED stamp is a mount animation, but the board rebuilds on every SSE
// event — only animate a seal the first time its card lands in Done, or it
// pops on every rebuild (visible as flicker whenever anything streams).
const stampedSeals = new Set();

function cardEl(t) {
  const el = document.createElement('div');
  const isRunning = RUNNING_LIKE[t.status];
  if (t.status !== 'done') stampedSeals.delete(t.id); // re-arm if it leaves Done
  el.className = 'card'
    + (isRunning ? ' running-card brush' : '')
    + (t.status === 'done' ? ' done-card' : '')
    + (t.error && t.status === 'review' ? ' failed-card' : '');
  el.draggable = !isRunning;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Open card: ${t.title}`);
  if (t.createdAt) el.title = `created ${relTime(t.createdAt)}${t.updatedAt ? ` · updated ${relTime(t.updatedAt)}` : ''}`;
  el.addEventListener('dragstart', (e) => { draggingNow = true; e.dataTransfer.setData('text/plain', t.id); });
  el.addEventListener('dragend', () => {
    draggingNow = false;
    if (renderQueued) { renderQueued = false; render(); }
  });
  el.addEventListener('click', () => openDrawer(t.id));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(t.id); }
  });

  const meta = [];
  if (t.priority >= 2) meta.push(`<span class="prio-high${t.priority >= 3 ? ' prio-urgent' : ''}" title="P${t.priority}"><span class="sr-only">priority P${t.priority}</span></span>`);
  if (t.createdBy === 'manager') meta.push('<span class="badge wt">sensei</span>');
  if (t.createdBy === 'import') meta.push('<span class="badge">import</span>');
  if (t.createdBy === 'auto') meta.push('<span class="badge skillauto">auto-fix</span>');
  if (t.createdBy === 'schedule') meta.push('<span class="badge sched">⏱ scheduled run</span>');
  meta.push(`<span class="badge model">${esc(t.model || 'default')}</span>`);
  if (t.effort && t.effort !== 'default') meta.push(`<span class="badge">${esc(t.effort)}</span>`);
  if (t.agent) meta.push(`<span class="badge">agent:${esc(t.agent)}</span>`);
  if (t.worktree) meta.push('<span class="badge wt">worktree</span>');
  if (t.issueNumber) meta.push(`<span class="badge">#${t.issueNumber}</span>`);
  // Dependency badge: amber "waiting on" while prerequisites are unmet (the
  // card sits in Queued until they ship), green chain once they're all done.
  const unmetDeps = depsUnmet(t);
  if (unmetDeps.length) {
    const first = unmetDeps[0].title;
    const more = unmetDeps.length > 1 ? ` +${unmetDeps.length - 1}` : '';
    meta.push(`<span class="badge dep" title="Waits until done: ${esc(unmetDeps.map((d) => d.title).join(' · '))}">⛓ after: ${esc(first.slice(0, 30))}${first.length > 30 ? '…' : ''}${more}</span>`);
  } else if ((t.deps || []).length) {
    meta.push(`<span class="badge dep-met" title="All prerequisites are done">⛓ deps met</span>`);
  }
  if ((t.depsUnresolved || []).length) {
    meta.push(`<span class="badge err" title="Unresolved after: ${esc(t.depsUnresolved.join(' · '))} — edit the card or let the Sensei fix the link">⛓ unresolved dep</span>`);
  }
  if (t.schedule) meta.push(`<span class="badge sched">⏱ ${esc(scheduleLabel(t.schedule))}</span>`);
  if (t.skillsAuto) meta.push('<span class="badge skillauto">✦ auto</span>');
  for (const s of (t.skills || []).slice(0, 3)) meta.push(`<span class="badge">${esc(s)}</span>`);
  if ((t.skills || []).length > 3) meta.push(`<span class="badge">+${t.skills.length - 3}</span>`);
  if (t.prUrl) meta.push(`<a class="pr-link" href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR ↗</a>`);
  // PR check rollup (from the PR watcher): red until CI is 100% green.
  if (t.prChecks && t.status !== 'done') {
    const c = t.prChecks;
    if (c.failing) meta.push(`<span class="badge err" title="Failing checks: ${esc((c.failed || []).join(' · '))}">CI ✕ ${c.failing}</span>`);
    else if (c.wrongBase) meta.push(`<span class="badge err" title="PR targets ${esc(c.base || '?')} but the card wants ${esc(t.prBaseBranch || '?')}">CI wrong base</span>`);
    else if (c.pending) meta.push(`<span class="badge" title="CI still running (${c.pending} pending)">CI … ${c.pending}</span>`);
    else if (c.passing) meta.push(`<span class="badge dep-met" title="All ${c.passing} checks green">CI ✓</span>`);
  }
  if (t.error && t.status !== 'done') meta.push(`<span class="failword">${t.error === 'Stopped by user' ? 'stopped' : 'failed'}</span>`);
  if (isRunning) {
    meta.push('<span class="runword">training…</span>');
    if (t.liveOut) meta.push(`<span class="badge">${fmtTok(t.liveOut)} out</span>`);
    if (t.ctxTokens) meta.push(`<span class="badge" title="Session context used (of the ~${fmtTok(CTX_WINDOW)} window)">ctx ${Math.round((t.ctxTokens / CTX_WINDOW) * 100)}%</span>`);
  } else if (t.stats && t.stats.turns) meta.push(`<span class="badge">${t.stats.turns} turns</span>`);

  const antenna = isRunning ? '<span class="antenna lit"></span>' : '';
  let seal = '';
  if (t.status === 'done') {
    const fresh = !stampedSeals.has(t.id);
    stampedSeals.add(t.id);
    seal = `<span class="seal card-seal${fresh ? ' seal--stamp' : ''}">Shipped</span>`;
  }
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
  if (qb) qb.addEventListener('click', (e) => {
    e.stopPropagation();
    withBusy(qb, async () => {
      const act = qb.dataset.act;
      if (act === 'run') await api(`/api/tasks/${t.id}/run`, { method: 'POST' });
      else if (act === 'unqueue') await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'backlog' } });
      else if (act === 'approve') {
        if (!(await confirmDlg(`Approve "${t.title}" — stamp it Done?`, { confirmLabel: '✓ Approve' }))) return;
        await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
      } else if (act === 'delete') {
        if (!(await confirmDlg('Delete this card and its transcript?', { confirmLabel: 'Delete', danger: true }))) return;
        await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
      }
    });
  });
  return el;
}

// Context-window size the ctx % is measured against. All current Claude Code
// models ship a 200k window; adjust here if that changes.
const CTX_WINDOW = 200_000;

// The dep cards that still block this one (deleted/archived ids count as met —
// same rule as the server).
function depsUnmet(t) {
  return (t.deps || [])
    .map((id) => tasks.find((x) => x.id === id))
    .filter((d) => d && d.status !== 'done');
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
    f.priority.value, f.acceptanceCriteria.value, f.schedule.value,
    [...document.querySelectorAll('#skillPicker .skill-chip.on')].map((c) => c.dataset.name || 'auto'),
    [...document.querySelectorAll('#depPicker .skill-chip.on')].map((c) => c.dataset.id),
  ]);
}

async function closeTaskModal(force = false) {
  if (!force && taskFormSnapshot() !== modalSnapshot) {
    if (!(await confirmDlg('Discard unsaved changes to this card?', { confirmLabel: 'Discard', danger: true }))) return;
  }
  $('#modalBackdrop').classList.add('hidden');
  if (modalReturnFocus) { try { modalReturnFocus.focus(); } catch {} modalReturnFocus = null; }
}

function openModal(task) {
  modalReturnFocus = document.activeElement;
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
  fillSelect(f.permissionMode, config.permissionModes, task ? task.permissionMode : (config.settings.defaultPermissionMode || 'acceptEdits'));
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
  chipify(auto);
  picker.appendChild(auto);
  const selected = new Set(task ? task.skills || [] : []);
  for (const s of config.skills) {
    const chip = document.createElement('span');
    chip.className = 'skill-chip' + (selected.has(s.name) ? ' on' : '');
    chip.textContent = s.name;
    chip.title = s.description || '';
    chip.dataset.name = s.name;
    chipify(chip);
    picker.appendChild(chip);
  }
  // "Runs after" picker: every other card is a candidate prerequisite. Current
  // deps lead, then live cards column-first; done cards only show if already
  // selected (a done dep is met — nothing to add there).
  const dp = $('#depPicker');
  dp.innerHTML = '';
  const chosen = new Set(task ? task.deps || [] : []);
  const candidates = tasks
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
    schedule: f.schedule.value,
    skills: [...document.querySelectorAll('#skillPicker .skill-chip.on')].filter((c) => !c.dataset.auto).map((c) => c.dataset.name),
    skillsAuto: !!document.querySelector('#skillPicker .skill-chip.auto.on'),
    deps: [...document.querySelectorAll('#depPicker .skill-chip.on')].map((c) => c.dataset.id),
  };
  const r = editingId
    ? await api(`/api/tasks/${editingId}`, { method: 'PATCH', body })
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

async function closeImportModal(force = false) {
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

function closeSettings() {
  $('#settingsBackdrop').classList.add('hidden');
  if (settingsReturnFocus) { try { settingsReturnFocus.focus(); } catch {} settingsReturnFocus = null; }
}

function openSettings() {
  settingsReturnFocus = document.activeElement;
  $('#logoutBtn').classList.toggle('hidden', !config.authGate);
  const f = $('#settingsForm');
  f.defaultCwd.value = config.settings.defaultCwd || '';
  fillSelect(f.defaultPermissionMode, config.permissionModes, config.settings.defaultPermissionMode || 'acceptEdits');
  f.reposDir.value = config.settings.reposDir || '';
  f.ntfyTopic.value = config.settings.ntfyTopic || '';
  f.notifyMac.checked = config.settings.notifyMac !== false;
  f.keepAwake.checked = config.settings.keepAwake !== false;
  f.archiveDays.value = config.settings.archiveDays ?? 7;
  f.prWatchMin.value = Number.isInteger(config.settings.prWatchMin) ? config.settings.prWatchMin : 10;
  f.prWatchAutoFix.checked = config.settings.prWatchAutoFix !== false;
  f.usageBudgetM.value = (config.settings.usageBudgetTokens || 0) / 1_000_000;
  renderUsage();
  renderSkillStatus();
  api('/api/version').then((v) => {
    if (v && v.version) $('#settingsVersion').textContent = `v${v.version}`;
  });
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
  config = await api('/api/config'); // re-scan repos for the picker
  closeSettings();
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
  btn.setAttribute('aria-pressed', light ? 'true' : 'false');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = light ? '#F6F2E9' : '#141210';
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
let drawerReturnFocus = null;

async function closeDrawer(force = false) {
  const t = tasks.find((x) => x.id === drawerId);
  if (!force && t && !$('#promptSaveBtn').classList.contains('hidden')
    && $('#promptEdit').value !== t.prompt
    && !(await confirmDlg('Discard the unsaved prompt edit?', { confirmLabel: 'Discard', danger: true }))) return;
  $('#drawer').classList.add('hidden');
  drawerId = null;
  if (drawerReturnFocus) { try { drawerReturnFocus.focus(); } catch {} drawerReturnFocus = null; }
}

async function openDrawer(id) {
  drawerReturnFocus = document.activeElement;
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
  const btn = e.target.querySelector('button[type="submit"]');
  const msg = input.value.trim();
  if (!msg || !drawerId || (btn && btn.disabled)) return;
  input.value = '';
  if (btn) btn.disabled = true;
  const r = await api(`/api/tasks/${drawerId}/followup`, { method: 'POST', body: { message: msg }, quiet: true });
  if (btn) btn.disabled = false;
  if (r.error) {
    const box = $('#transcript');
    const pinned = nearBottom(box);
    box.appendChild(entryEl({ kind: 'error', text: r.error }));
    if (pinned) box.scrollTop = box.scrollHeight;
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
  // Live too: a card blocked on permission is fixed by raising this, then re-running.
  mkSel('perms', config.permissionModes, t.permissionMode, 'permissionMode');

  const bits = [`cwd: ${t.cwd}`];
  if (t.prChecks) {
    const c = t.prChecks;
    bits.push(`CI: ${c.failing ? `✕ ${c.failing} failing — ${(c.failed || []).join(' · ')}` : c.pending ? `… ${c.pending} running` : `✓ ${c.passing} green`}${c.base ? ` · base ${c.base}` : ''}${c.wrongBase ? ` (card wants ${t.prBaseBranch})` : ''}`);
  }
  const unmetD = depsUnmet(t);
  if (unmetD.length) bits.push(`⛓ waits for: ${unmetD.map((d) => d.title).join(' · ')}`);
  else if ((t.deps || []).length) bits.push('⛓ all prerequisites done');
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

function renderDrawerActions(t) {
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

$('#drawerClose').addEventListener('click', () => closeDrawer());

// ---------- Escape + focus trap for modals, the drawer, and dialogs ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('dialog.kk-dialog[open]')) return; // <dialog> closes itself
    if (!$('#modalBackdrop').classList.contains('hidden')) { e.preventDefault(); closeTaskModal(); }
    else if (!$('#importBackdrop').classList.contains('hidden')) { e.preventDefault(); closeImportModal(); }
    else if (!$('#settingsBackdrop').classList.contains('hidden')) { e.preventDefault(); closeSettings(); }
    else if (!$('#drawer').classList.contains('hidden')) { e.preventDefault(); closeDrawer(); }
    return;
  }
  if (e.key !== 'Tab') return;
  const overlay = document.querySelector('.backdrop:not(.hidden) .modal') || (!$('#drawer').classList.contains('hidden') ? $('#drawer') : null);
  if (!overlay) return;
  const foci = [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!foci.length) return;
  const first = foci[0];
  const last = foci[foci.length - 1];
  if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
    e.preventDefault(); first.focus();
  }
});

// ---------- manager tab ----------
let mgrState = null;

function showTab(which) {
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

async function loadManager() {
  mgrState = await api('/api/manager');
  renderManager();
}

// SSE refreshes rewrite the settings form from server state — but never while
// the user has unsaved edits mid-form (that silently threw their input away).
let mgrFormDirty = false;
$('#mgrForm').addEventListener('input', () => { mgrFormDirty = true; });

function setMgrBusy(busy) {
  $('#mgrBusy').classList.toggle('hidden', !busy);
  const form = $('#mgrChatForm');
  form.message.disabled = !!busy;
  form.querySelector('button[type="submit"]').disabled = !!busy;
  form.message.placeholder = busy
    ? 'the Sensei is thinking — one run at a time…'
    : "e.g. plan the auth refactor into cards, or: what's blocking?";
}

function renderManager() {
  if (!mgrState) return;
  const c = mgrState.config;
  const f = $('#mgrForm');
  if (!mgrFormDirty) {
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
  }

  setMgrBusy(mgrState.busy);

  // chat
  const chat = $('#mgrChat');
  const pinned = !chat.children.length || nearBottom(chat);
  chat.innerHTML = '';
  for (const m of mgrState.chat) {
    const div = document.createElement('div');
    div.className = `chat-msg ${m.role}`;
    div.textContent = m.text;
    chat.appendChild(div);
  }
  if (pinned) chat.scrollTop = chat.scrollHeight;

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
    div.textContent = `${fmtLogTs(e.ts)} · ${e.kind} · ${e.text}`;
    logBox.appendChild(div);
  }
}

// log timestamps: time-of-day today, date + time otherwise (no ambiguity after midnight)
function fmtLogTs(ts) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString();
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  if (!msg || input.disabled || (mgrState && mgrState.busy)) return;
  input.value = '';
  setMgrBusy(true); // one Sensei run at a time — each is a paid subscription call
  (async () => {
    await api('/api/manager/chat', { method: 'POST', body: { message: msg } });
    await loadManager(); // renderManager restores the real busy state
  })();
});

// ---------- live updates ----------
const es = new EventSource('/api/events');
// EventSource reconnects on its own; surface the gap so a stale board is
// visibly stale, and refetch on recovery to close it.
let sseWasDown = false;
es.addEventListener('error', () => {
  sseWasDown = true;
  $('#sseChip').classList.remove('hidden');
});
es.addEventListener('open', () => {
  $('#sseChip').classList.add('hidden');
  if (sseWasDown) {
    sseWasDown = false;
    loadTasks();
    if (!$('#managerView').classList.contains('hidden')) loadManager();
  }
});
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
      setMgrBusy(evt.busy);
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
    const pinned = nearBottom(box); // don't yank the reader back down mid-scrollback
    box.appendChild(entryEl(evt.entry));
    if (pinned) box.scrollTop = box.scrollHeight;
  }
};

// ---------- board filter ----------
$('#filterInput').addEventListener('input', (e) => {
  filterText = e.target.value.trim().toLowerCase();
  render();
});

// ---------- settings ----------
$('#maxConcurrent').addEventListener('change', async (e) => {
  config.settings = await api('/api/settings', { method: 'PUT', body: { maxConcurrent: parseInt(e.target.value, 10) } });
});

// ---------- init ----------
async function loadTasks() {
  const r = await api('/api/tasks');
  if (!Array.isArray(r)) return false; // error already toasted; keep the last good board
  tasks = r;
  render();
  return true;
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
    const left = Math.max(0, u.budgetTokens - u.output);
    const pct = Math.round((u.output / u.budgetTokens) * 100);
    txt.textContent = `5h ${fmtTok(left)} left`;
    chip.classList.toggle('warn', pct >= 70 && pct < 90);
    chip.classList.toggle('bad', pct >= 90);
  } else {
    txt.textContent = `5h ${fmtTok(u.output)}`;
    chip.classList.remove('warn', 'bad');
  }
  chip.classList.remove('hidden');
  const bd = $('#usageBreakdown');
  bd.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'usage-grid';
  const stats = [
    [fmtTok(u.output), 'out tok', ''],
    [fmtTok(u.input), 'in tok', ''],
    [fmtTok(u.cacheRead), 'cached', ''],
    [String(u.turns), 'turns', ''],
  ];
  if (u.budgetTokens > 0) {
    const left = Math.max(0, u.budgetTokens - u.output);
    const pct = Math.round((u.output / u.budgetTokens) * 100);
    stats.unshift([fmtTok(left), 'left (5h)', pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok']);
  }
  for (const [val, label, tone] of stats) {
    const s = document.createElement('div');
    s.className = 'u-stat';
    const b = document.createElement('b');
    b.textContent = val;
    if (tone) b.className = tone;
    const l = document.createElement('span');
    l.textContent = label;
    s.append(b, l);
    grid.appendChild(s);
  }
  bd.appendChild(grid);
  if (u.budgetTokens > 0) {
    const pct = Math.min(100, Math.round((u.output / u.budgetTokens) * 100));
    const bar = document.createElement('div');
    bar.className = 'u-bar';
    const fill = document.createElement('div');
    fill.className = 'u-fill' + (pct >= 90 ? ' bad' : pct >= 70 ? ' warn' : '');
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    bar.title = `${pct}% of your ${fmtTok(u.budgetTokens)} budget`;
    bd.appendChild(bar);
  }
  const models = Object.entries(u.byModel || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (models.length) {
    const row = document.createElement('div');
    row.className = 'u-models';
    for (const [m, n] of models) {
      const chip = document.createElement('span');
      chip.className = 'badge';
      chip.textContent = `${m} ${fmtTok(n)}`;
      row.appendChild(chip);
    }
    bd.appendChild(row);
  }
  const cap = document.createElement('span');
  cap.className = 'footnote';
  cap.textContent = 'all Claude Code on this Mac · rolling 5-hour window';
  bd.appendChild(cap);
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
  // "2.1.212 (Claude Code)" → "claude 2.1.212" — the parenthetical is noise here
  const claudeVer = `claude ${esc((h.claude.out || '').replace(/\s*\(.*\)$/, '') || '?')}`;
  const boardVer = v && v.version
    ? `kungfu v${esc(v.version)}${v.updateAvailable
      ? ` <button id="updateBoardBtn" class="ghost mini warn" title="Your clone is ${v.behind} commit${v.behind > 1 ? 's' : ''} behind origin — pulls fast-forward and restarts the board">⬆ ${v.remoteVersion ? `v${esc(v.remoteVersion)}` : 'update'} available</button>`
      : ''} · `
    : '';
  if (h.claude.ok && h.gh.ok) {
    el.innerHTML = `${boardVer}${dot(true)} ${claudeVer}${upBtn} · ${dot(true)} gh`;
  } else {
    el.innerHTML = boardVer + [
      h.claude.ok ? `${dot(true)} ${claudeVer}${upBtn}` : `${dot(false)} claude CLI not working — cards can't run`,
      h.gh.ok ? `${dot(true)} gh` : `${dot(false)} gh not authed — PR features off`,
    ].join(' · ');
  }
  const bb = $('#updateBoardBtn');
  if (bb) bb.addEventListener('click', async () => {
    if (!(await confirmDlg('Update the board to the latest code? It pulls from origin and restarts itself (blocked while cards are running). Under plain `npm start` the server stops instead — restart it after.', { confirmLabel: '⬆ Update' }))) return;
    bb.disabled = true;
    bb.textContent = '⬆ updating…';
    const r = await api('/api/system/update-board', { method: 'POST', quiet: true });
    if (r.error) {
      await alertDlg(`Update failed: ${r.error}`);
      renderHealth();
      return;
    }
    bb.textContent = '⬆ restarting…';
    // launchd throttles respawns (~10s) — poll until the server is back
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok || res.status === 302 || res.status === 401) {
          clearInterval(poll);
          location.reload();
        }
      } catch {}
    }, 3000);
  });
  const ub = $('#updateClaudeBtn');
  if (ub) ub.addEventListener('click', async () => {
    if (!(await confirmDlg('Update the Claude Code CLI now? Running agents finish on the old version; new runs use the new one.', { confirmLabel: '↑ Update' }))) return;
    ub.disabled = true;
    ub.textContent = '↑ updating…';
    const r = await api('/api/system/update-claude', { method: 'POST', quiet: true });
    await alertDlg(r.ok ? (r.output || 'Updated.') : `Update failed: ${r.error || 'unknown error'}`);
    renderHealth();
  });
}
// the tooltip promises "checked every few minutes" — keep that promise
setInterval(renderHealth, 5 * 60_000);

// ---------- boot: visible loading + a real error state ----------
function bootError(msg) {
  $('#board').innerHTML = `
    <div class="dojo-empty boot-state">
      <h3>Can't reach the dojo</h3>
      <p class="boot-err"></p>
      <div class="empty-actions"><button class="primary" onclick="location.reload()">↻ Retry</button></div>
    </div>`;
  $('#board').classList.add('is-empty');
  $('#board').querySelector('.boot-err').textContent = msg;
}

(async () => {
  $('#board').innerHTML = '<div class="dojo-empty boot-state"><p class="boot-msg">contacting the dojo…</p></div>';
  $('#board').classList.add('is-empty');
  let cfg;
  try {
    cfg = await api('/api/config', { quiet: true });
  } catch (e) {
    cfg = { error: String(e.message || e) };
  }
  if (!cfg || cfg.error || !cfg.settings) {
    bootError(cfg && cfg.error ? cfg.error : 'the server did not answer — is it running?');
    return;
  }
  config = cfg;
  $('#board').classList.remove('is-empty');
  $('#maxConcurrent').value = config.settings.maxConcurrent || 2;
  applyCooldown(config.cooldownUntil || 0);
  applyModelBlocks(config.modelBlocks || {});
  if (!(await loadTasks())) { bootError('loaded config, but the task list failed — retry?'); return; }
  renderHealth();
  renderUsage();
})();

// minimal service worker: makes "add to home screen" a real PWA (cached shell
// when offline); it never intercepts /api/, so live data stays live
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
