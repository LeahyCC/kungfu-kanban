/* Board rendering: the column layout, card DOM, groups, drag/drop, and the
 * loadTasks fetch that feeds them. */

import { state, COLUMNS, RUNNING_LIKE, CTX_WINDOW } from './state.js';
import { $, esc, relTime, fmtTok, scheduleLabel } from './util.js';
import { api, toast, confirmDlg, withBusy } from './api.js';
import { depsUnmet, isPrUnshipped, chainDepth } from './deps.js';
import { openDrawer } from './drawer.js';
import { openModal } from './modals.js';

// Rebuilding mid-drag kills the drag; defer renders until it ends. Column
// scroll positions are restored across rebuilds.
let draggingNow = false;
let renderQueued = false;
let filterText = '';
let lastRenderFingerprint = null;

// Which group headers are collapsed, by group name — persists across reloads.
// Purely a display toggle on already-rendered DOM, so it never has to go
// through render()'s fingerprint-gated rebuild.
let collapsedGroups = new Set();
try { collapsedGroups = new Set(JSON.parse(localStorage.getItem('kk-groups-collapsed') || '[]')); } catch {}

// The board filter input writes here (filterText stays private to this module).
export function setFilter(text) {
  filterText = text;
}

function matchesFilter(t) {
  if (!filterText) return true;
  const hay = [t.title, t.prompt, t.cwd, t.model, t.agent, ...(t.skills || [])]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(filterText);
}

export function render() {
  if (draggingNow) { renderQueued = true; return; }
  // task events fire every ~2s per running task; skip the rebuild when
  // nothing render-relevant actually changed to avoid churning focus/selection
  const fingerprint = JSON.stringify(state.tasks) + '|' + filterText;
  if (fingerprint === lastRenderFingerprint) return;
  lastRenderFingerprint = fingerprint;

  const board = $('#board');
  const scrolls = {};
  for (const c of board.querySelectorAll('.column')) {
    scrolls[c.dataset.status] = c.querySelector('.col-body').scrollTop;
  }
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.card');
  const focusedId = focused ? focused.dataset.id : null;

  board.innerHTML = '';
  board.classList.toggle('is-empty', !state.tasks.length);

  updateHeaderStatus();

  if (!state.tasks.length) {
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
    const colTasks = state.tasks
      .filter(matchesFilter)
      .filter((t) => (col.key === 'running' ? RUNNING_LIKE[t.status] : t.status === col.key))
      .sort((a, b) => chainDepth(a) - chainDepth(b) || (b.priority || 0) - (a.priority || 0));
    const el = document.createElement('div');
    el.className = 'column';
    el.dataset.status = col.key;
    el.innerHTML = `
      <div class="col-head"><span class="col-name">${col.label}</span><span class="col-count">${colTasks.length}</span></div>
      <div class="col-body"></div>`;
    const body = el.querySelector('.col-body');
    if (!colTasks.length) body.innerHTML = '<div class="empty-col">—</div>';
    // Ungrouped cards render as before; a card with a `group` joins a wrapper
    // positioned where the FIRST card of that group falls in the existing
    // sort — no separate ordering rule invented for groups.
    const seenGroups = new Set();
    for (const t of colTasks) {
      if (!t.group) { body.appendChild(cardEl(t)); continue; }
      if (seenGroups.has(t.group)) continue;
      seenGroups.add(t.group);
      body.appendChild(groupEl(t.group, colTasks.filter((x) => x.group === t.group)));
    }

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
        const t = state.tasks.find((x) => x.id === id);
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

  if (focusedId) {
    const toFocus = board.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`);
    if (toFocus) toFocus.focus();
  }
}

function updateHeaderStatus() {
  const counts = { backlog: 0, queued: 0, running: 0, stopping: 0, review: 0, done: 0 };
  for (const t of state.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
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

// Visual-only wrapper — drag/drop listeners live on the column, not here, so
// dragging a grouped card still bubbles up to the column's own handlers.
function groupEl(name, colGroupTasks) {
  const wrap = document.createElement('div');
  const collapsed = collapsedGroups.has(name);
  wrap.className = 'card-group' + (collapsed ? ' collapsed' : '');
  const total = state.tasks.filter((x) => x.group === name).length;
  const done = state.tasks.filter((x) => x.group === name && x.status === 'done').length;
  const head = document.createElement('div');
  head.className = 'card-group-head';
  head.tabIndex = 0;
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', String(!collapsed));
  const backlogMembers = colGroupTasks.filter((t) => t.status === 'backlog');
  const queueBtn = backlogMembers.length
    ? `<button class="card-run card-group-queue" data-act="queue-group" title="${esc(`Queue ${backlogMembers.length} cards`)}" aria-label="${esc(`Queue ${backlogMembers.length} cards`)}">▶</button>`
    : '';
  head.innerHTML = `<span class="card-group-chevron">▾</span><span class="card-group-name">${esc(name)}</span><span class="card-group-count">${done}/${total} done</span>${queueBtn}`;
  const qb = head.querySelector('.card-group-queue');
  if (qb) qb.addEventListener('click', (e) => {
    e.stopPropagation();
    withBusy(qb, async () => {
      const ordered = backlogMembers.slice().sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      let queued = 0;
      const waitingOn = [];
      for (const t of ordered) {
        const r = await api(`/api/tasks/${t.id}/run`, { method: 'POST' });
        if (r.queued && r.waitingOn && r.waitingOn.length) waitingOn.push(t.title);
        else queued++;
      }
      toast(`queued ${queued}${waitingOn.length ? ` — ${waitingOn.length} waiting on deps` : ''}`, 'status');
    });
  });
  const toggle = () => {
    const isCollapsed = wrap.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!isCollapsed));
    if (isCollapsed) collapsedGroups.add(name); else collapsedGroups.delete(name);
    localStorage.setItem('kk-groups-collapsed', JSON.stringify([...collapsedGroups]));
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.target !== head) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  const cardsBox = document.createElement('div');
  cardsBox.className = 'card-group-cards';
  for (const t of colGroupTasks) cardsBox.appendChild(cardEl(t));
  wrap.append(head, cardsBox);
  return wrap;
}

function cardEl(t) {
  const el = document.createElement('div');
  const isRunning = RUNNING_LIKE[t.status];
  if (t.status !== 'done') stampedSeals.delete(t.id); // re-arm if it leaves Done
  el.dataset.id = t.id;
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
    const firstIsMergeWait = isPrUnshipped(unmetDeps[0]);
    const label = firstIsMergeWait ? '⛓ waits for merge:' : '⛓ after:';
    const title = firstIsMergeWait
      ? `${unmetDeps[0].title} is approved but its PR is still open — merging releases this card`
      : `Waits until done: ${esc(unmetDeps.map((d) => d.title).join(' · '))}`;
    meta.push(`<span class="badge dep" title="${esc(title)}">${label} ${esc(first.slice(0, 30))}${first.length > 30 ? '…' : ''}${more}</span>`);
  } else if ((t.deps || []).length) {
    meta.push(`<span class="badge dep-met" title="All prerequisites are done">⛓ deps met</span>`);
  }
  if ((t.depsUnresolved || []).length) {
    meta.push(`<span class="badge err" title="Unresolved after: ${esc(t.depsUnresolved.join(' · '))} — edit the card or let the Sensei fix the link">⛓ unresolved dep</span>`);
  }
  // Bottleneck flag: this verdict (or an unmerged PR on an already-approved
  // card) is what queued work is waiting for.
  if (t.status === 'review' || isPrUnshipped(t)) {
    const held = state.tasks.filter((x) => x.status === 'queued' && (x.deps || []).includes(t.id));
    if (held.length) meta.push(`<span class="badge dep" title="Queued work waits on this verdict: ${esc(held.map((x) => x.title).join(' · '))} — ${t.prUrl ? 'merge its PR or approve' : 'approve or reject'} to release">🖐 blocks ${held.length}</span>`);
  }
  if (t.schedule) meta.push(`<span class="badge sched">⏱ ${esc(scheduleLabel(t.schedule))}</span>`);
  if (t.skillsAuto) meta.push('<span class="badge skillauto">✦ auto</span>');
  for (const s of (t.skills || []).slice(0, 3)) meta.push(`<span class="badge">${esc(s)}</span>`);
  if ((t.skills || []).length > 3) meta.push(`<span class="badge">+${t.skills.length - 3}</span>`);
  if (t.prUrl) meta.push(`<a class="pr-link" href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR ↗</a>`);
  // PR check rollup (from the PR watcher): red until CI is 100% green.
  if (t.prChecks && t.status !== 'done') {
    const c = t.prChecks;
    if (c.conflicting) meta.push(`<span class="badge err" title="Merge conflicts with ${esc(c.base || 'the base branch')} — auto-fix runs when enabled">⚔ conflicts</span>`);
    if (c.failing) meta.push(`<span class="badge err" title="Failing checks: ${esc((c.failed || []).join(' · '))}">CI ✕ ${c.failing}</span>`);
    else if (c.wrongBase) meta.push(`<span class="badge err" title="PR targets ${esc(c.base || '?')} but the card wants ${esc(t.prBaseBranch || '?')}">CI wrong base</span>`);
    else if (c.pending) meta.push(`<span class="badge" title="CI still running (${c.pending} pending)">CI … ${c.pending}</span>`);
    else if (c.passing) meta.push(`<span class="badge dep-met" title="All ${c.passing} checks green">CI ✓</span>`);
    else if (c.noCi) meta.push('<span class="badge" title="No checks reported — this repo has no CI; review judges the diff alone">no CI</span>');
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
  if (t.status === 'backlog') {
    const runTitle = unmetDeps.length ? `Queues after: ${unmetDeps[0].title}` : 'Run now';
    quick = `<button class="card-run" data-act="run" title="${esc(runTitle)}" aria-label="Run now">▶</button>`;
  }
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
      if (act === 'run') {
        const r = await api(`/api/tasks/${t.id}/run`, { method: 'POST' });
        if (r.queued && r.waitingOn && r.waitingOn.length) toast(`⛓ queued — waits on: ${r.waitingOn.join(' · ')}`, 'status');
      }
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

export async function loadTasks() {
  const r = await api('/api/tasks');
  if (!Array.isArray(r)) return false; // error already toasted; keep the last good board
  state.tasks = r;
  render();
  return true;
}
