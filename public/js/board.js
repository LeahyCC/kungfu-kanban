/* Board rendering: the column layout, card DOM, groups, drag/drop, and the
 * loadTasks fetch that feeds them.
 *
 * Rendering is keyed reconciliation, not innerHTML='' rebuilds: card/column/
 * group nodes live in Maps keyed by id and are MOVED into their target order
 * (appendChild/insertBefore on an existing node is a cheap move). A card's
 * content is patched only when its revision key changes — task.v when the
 * server stamps it, a shallow rendered-field compare otherwise, plus a
 * dependency-derived part (dep revisions + "blocks N" holders) so badges that
 * depend on OTHER cards still refresh. All interactivity is event delegation
 * on #board, so reused nodes never need listener re-attachment and a disabled
 * (withBusy) button stays disabled across renders. */

import { state, COLUMNS, RUNNING_LIKE, CTX_WINDOW, optimistic } from './state.js';
import { $, esc, relTime, fmtTok, scheduleLabel } from './util.js';
import { api, toast, confirmDlg, withBusy } from './api.js';
import { isPrUnshipped, depPass } from './deps.js';
import { openDrawer } from './drawer.js';
import { openModal } from './modals.js';

// Rebuilding mid-drag kills the drag; defer renders until it ends. Column
// elements (and their scroll positions) persist across renders.
let draggingNow = false;
let renderQueued = false;
let filterText = '';
let lastRenderFingerprint = null;

// Which group headers are collapsed, by group name — persists across reloads.
// Applied as a class on the (reused) group wrapper, so it never has to go
// through render()'s fingerprint gate.
let collapsedGroups = new Set();
try { collapsedGroups = new Set(JSON.parse(localStorage.getItem('kk-groups-collapsed') || '[]')); } catch {}

// The board filter input writes here (filterText stays private to this module).
export function setFilter(text) {
  filterText = text;
}

// Lowercase search haystack per task, cached by object identity — SSE and
// optimistic updates always REPLACE task objects, so a changed task misses the
// cache automatically and there is nothing to invalidate.
const haystackCache = new WeakMap();
export function haystackFor(t) {
  let h = haystackCache.get(t);
  if (h === undefined) {
    h = [t.title, t.prompt, t.cwd, t.model, t.agent, ...(t.skills || [])]
      .filter(Boolean).join(' ').toLowerCase();
    haystackCache.set(t, h);
  }
  return h;
}
function matchesFilter(t) {
  return !filterText || haystackFor(t).includes(filterText);
}

// ---------- keyed node caches ----------
// id → { el, rev } for cards; colKey → column record; "col|group" → group record.
const cardNodes = new Map();
const colNodes = new Map();
const groupNodes = new Map();
const tabFocus = new Map(); // colKey → id of the roving-tabindex card

// The SHIPPED stamp is a mount animation — only animate a seal the first time
// its card lands in Done, or it pops on every patch. Node reuse plus the
// className-unchanged guard below gives .running-card.brush the same guard.
const stampedSeals = new Set();

// Rendered-own-fields subset for the no-v fallback revision compare.
const OWN_FIELDS = ['status', 'title', 'priority', 'createdBy', 'model', 'effort', 'agent',
  'worktree', 'issueNumber', 'deps', 'depsUnresolved', 'prUrl', 'prChecks', 'error', 'liveOut',
  'ctxTokens', 'stats', 'schedule', 'skillsAuto', 'skills', 'createdAt', 'updatedAt', 'group',
  'permissionBlocked', 'openPr', 'prMergedAt', 'prClosedNoted', 'prBaseBranch'];

function ownHash(t) {
  let s = '';
  for (const f of OWN_FIELDS) s += JSON.stringify(t[f] == null ? null : t[f]) + '|';
  return s;
}

// Revision key: patch the card only when this changes. With task.v present it
// is cheap ("v changed ⇒ anything may have changed"); without v it is a
// shallow compare of exactly the fields cardEl renders. Either way it ALSO
// carries a dependency-derived part — a prerequisite shipping or a queued
// holder appearing changes this card's badges without touching its own v.
function cardRevKey(t, pass) {
  let key = t.v !== undefined ? `v${t.v}` : `h${ownHash(t)}`;
  if (t._optRev) key += `|o${t._optRev}`; // optimistic local overlay (never from the server)
  if ((t.deps || []).length) {
    key += '|d:' + t.deps.map((id) => {
      const d = pass.byId.get(id);
      if (!d) return `${id}:gone`;
      const dv = d.v !== undefined ? `v${d.v}` : `${d.status}/${d.title || ''}`;
      return `${id}:${dv}:${isPrUnshipped(d) ? 1 : 0}`;
    }).join(',');
  }
  if (t.status === 'review' || isPrUnshipped(t)) {
    key += '|h:' + pass.held(t.id).map((x) => `${x.id}:${x.v !== undefined ? 'v' + x.v : x.title || ''}`).join(',');
  }
  return key;
}

// Cheap board-level gate: when every task carries v, the fingerprint is the
// id:v list instead of a full JSON stringify of the payload.
function boardFingerprint() {
  let cheap = `${filterText}|`;
  for (const t of state.tasks) {
    if (t.v === undefined) return `${JSON.stringify(state.tasks)}|${filterText}`;
    cheap += `${t.id}:${t.v};${t._optRev || ''};`;
  }
  return cheap;
}

// ---------- FLIP motion (transform/opacity only, reduced-motion gated) ----------
// Uses the .flip-move / .flip-enter / .flip-leave classes from style.css, which
// are themselves inside a no-preference media block; the matchMedia gate below
// additionally skips the rect reads entirely for reduced-motion users.
let flipMq = null;
function flipEnabled() {
  if (typeof matchMedia !== 'function') return false;
  if (!flipMq) flipMq = matchMedia('(prefers-reduced-motion: no-preference)');
  return !!flipMq.matches;
}

function captureRects() {
  const rects = new Map();
  for (const [id, rec] of cardNodes) {
    if (rec.el.isConnected && !rec.el._flipLeaving) rects.set(id, rec.el.getBoundingClientRect());
  }
  return rects;
}

function clearFlipStyles(el) {
  if (el._flipLeaveTimer) { clearTimeout(el._flipLeaveTimer); el._flipLeaveTimer = null; }
  el._flipLeaving = false;
  el.classList.remove('flip-move', 'flip-enter', 'flip-leave');
  el.style.position = '';
  el.style.left = '';
  el.style.top = '';
  el.style.width = '';
  el.style.margin = '';
  el.style.pointerEvents = '';
  el.style.transform = '';
}

// Remove a flip helper class when its transition/animation ends (with a timer
// fallback — some engines skip the end events).
function flipClassDuring(el, cls, ms) {
  el.classList.add(cls);
  const cleanup = () => {
    el.classList.remove(cls);
    el.removeEventListener('transitionend', cleanup);
    el.removeEventListener('animationend', cleanup);
  };
  el.addEventListener('transitionend', cleanup);
  el.addEventListener('animationend', cleanup);
  setTimeout(cleanup, ms);
}

// Leaving cards fade out absolutely positioned so the remaining cards can
// FLIP into the freed space underneath them.
function animateLeave(el) {
  if (!flipEnabled() || !el.classList || !el.classList.contains('card') || el._flipLeaving) {
    el.remove();
    return;
  }
  try {
    el._flipLeaving = true;
    el.style.position = 'absolute';
    el.style.left = `${el.offsetLeft}px`;
    el.style.top = `${el.offsetTop}px`;
    el.style.width = `${el.offsetWidth}px`;
    el.style.margin = '0';
    el.style.pointerEvents = 'none';
    el.classList.add('flip-leave');
    el._flipLeaveTimer = setTimeout(() => {
      el._flipLeaving = false;
      el.classList.remove('flip-leave');
      el.remove();
    }, 200);
  } catch {
    el._flipLeaving = false;
    el.remove();
  }
}

function playFlip(before, born) {
  if (!before) return;
  for (const [id, r] of before) {
    const rec = cardNodes.get(id);
    if (!rec || !rec.el.isConnected || rec.el._flipLeaving) continue;
    const el = rec.el;
    const r2 = el.getBoundingClientRect();
    const dx = r.left - r2.left;
    const dy = r.top - r2.top;
    if (!dx && !dy) continue;
    if (el.classList.contains('brush')) continue; // never fight the running-card animation
    el.style.transform = `translate(${dx}px, ${dy}px)`; // invert (no transition yet)
    el.getBoundingClientRect(); // force reflow so the invert sticks
    el.style.transform = ''; // play: .flip-move's transition animates to identity
    flipClassDuring(el, 'flip-move', 250);
  }
  if (before.size) {
    for (const el of born) {
      if (!el.isConnected || el.classList.contains('brush')) continue;
      flipClassDuring(el, 'flip-enter', 250);
    }
  }
}

// ---------- generic ordered-child reconciliation ----------
// Two-phase across a whole render pass: first every container's target list is
// computed, then reconciles run against the UNION of all wanted nodes. A node
// moving between containers (e.g. card leaving a group for the plain column
// list) is wanted elsewhere, so the source container must NOT treat it as
// leaving — its new container's insert pass moves it (insertBefore relocates
// an already-parented node). Only genuinely departing nodes get onLeave.
// Nodes mid-leave-animation keep their DOM slot until their timer removes them.
function reconcileChildren(container, targetNodes, wanted, onLeave) {
  const target = new Set(targetNodes);
  for (const kid of [...container.children]) {
    if (!target.has(kid) && !kid._flipLeaving && !wanted.has(kid)) {
      if (onLeave) onLeave(kid); else container.removeChild(kid);
    }
  }
  const nextLive = (n) => { while (n && n._flipLeaving) n = n.nextSibling; return n; };
  let cursor = nextLive(container.firstChild);
  for (const node of targetNodes) {
    if (node === cursor) { cursor = nextLive(cursor.nextSibling); continue; }
    container.insertBefore(node, cursor); // cursor may be null → append at end
  }
}

function runReconcileJobs(jobs, onLeave) {
  const wanted = new Set();
  for (const j of jobs) for (const n of j.targets) wanted.add(n);
  for (const j of jobs) reconcileChildren(j.container, j.targets, wanted, onLeave);
}

// ---------- columns (persistent elements; drag/drop attached once) ----------
function columnEl(col) {
  let rec = colNodes.get(col.key);
  if (rec) return rec;
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.status = col.key;
  el.setAttribute('role', 'region');
  const head = document.createElement('div');
  head.className = 'col-head';
  const name = document.createElement('span');
  name.className = 'col-name';
  name.textContent = col.label;
  const count = document.createElement('span');
  count.className = 'col-count';
  head.append(name, count);
  const body = document.createElement('div');
  body.className = 'col-body';
  body.setAttribute('role', 'list');
  el.append(head, body);
  const empty = document.createElement('div');
  empty.className = 'empty-col';
  empty.textContent = '—';
  rec = { el, head, body, countEl: count, emptyEl: empty, key: col.key, dragDepth: 0 };
  colNodes.set(col.key, rec);
  if (col.key !== 'running') attachDropHandlers(rec, col);
  return rec;
}

function attachDropHandlers(rec, col) {
  const el = rec.el;
  // dragleave fires when crossing into child cards — the depth counter keeps
  // the outline from strobing. It lives on the (persistent) record, so it
  // survives renders mid-dragover.
  el.addEventListener('dragenter', (e) => { e.preventDefault(); rec.dragDepth++; el.classList.add('drag-over'); });
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('dragleave', () => {
    if (--rec.dragDepth <= 0) { rec.dragDepth = 0; el.classList.remove('drag-over'); }
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    rec.dragDepth = 0;
    el.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/plain');
    const t = state.tasks.find((x) => x.id === id);
    if (!t || RUNNING_LIKE[t.status] || t.status === col.key) return;
    if (col.key === 'done'
      && !(await confirmDlg(`Mark "${t.title}" as Done? No run happens — the card just ships.`, { confirmLabel: '✓ Ship it' }))) return;
    // optimistic: the card moves now; a failure rolls it back (api toasts).
    const prev = applyOptimistic(id, { status: col.key });
    const r = col.key === 'queued'
      ? await api(`/api/tasks/${id}/run`, { method: 'POST' })
      : await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: col.key } });
    if (!r || r.error) rollbackOptimistic(id, prev);
    else mergeTaskResponse(r);
  });
}

// ---------- cards ----------
function getCardEl(t, pass, born) {
  let rec = cardNodes.get(t.id);
  if (!rec) {
    const el = document.createElement('div');
    el.dataset.id = t.id;
    rec = { el, rev: null };
    cardNodes.set(t.id, rec);
    if (born) born.add(el);
  }
  if (rec.el._flipLeaving) clearFlipStyles(rec.el); // re-entering while fading out
  const rev = cardRevKey(t, pass);
  if (rec.rev !== rev) {
    rec.rev = rev;
    patchCardEl(rec.el, t, pass);
  }
  return rec.el;
}

function columnLabelFor(t) {
  if (RUNNING_LIKE[t.status]) return 'Running';
  const col = COLUMNS.find((c) => c.key === t.status);
  return col ? col.label : t.status;
}

function patchCardEl(el, t, pass) {
  const isRunning = RUNNING_LIKE[t.status];
  if (t.status !== 'done') stampedSeals.delete(t.id); // re-arm if it leaves Done
  const cls = 'card'
    + (isRunning ? ' running-card brush' : '')
    + (t.status === 'done' ? ' done-card' : '')
    + (t.error && t.status === 'review' ? ' failed-card' : '');
  // assigning className only on change keeps the .brush mount animation from
  // restarting when an unrelated field re-patches the card
  if (el.className !== cls) el.className = cls;
  el.draggable = !isRunning;
  // No role="button" here: the card CONTAINS real <button>/<a> controls and a
  // nested-interactive is an a11y violation. It is a listitem (the column body
  // is role="list") that is focusable and Enter/Space-operable via delegation.
  el.setAttribute('role', 'listitem');
  el.setAttribute('aria-label', `Card: ${t.title} — ${columnLabelFor(t)}. Press Enter to open details.`);
  if (t.createdAt) el.title = `created ${relTime(t.createdAt)}${t.updatedAt ? ` · updated ${relTime(t.updatedAt)}` : ''}`;

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
  const unmetDeps = pass.unmet(t);
  if (unmetDeps.length) {
    const first = unmetDeps[0].title;
    const more = unmetDeps.length > 1 ? ` +${unmetDeps.length - 1}` : '';
    const firstIsMergeWait = isPrUnshipped(unmetDeps[0]);
    const label = firstIsMergeWait ? '⛓ waits for merge:' : '⛓ after:';
    const title = firstIsMergeWait
      ? `${unmetDeps[0].title} is approved but its PR is still open — merging releases this card`
      : `Waits until done: ${esc(unmetDeps.map((d) => d.title).join(' · '))}`;
    meta.push(`<span class="badge dep" title="${esc(title)}">${label} ${esc(String(first || '').slice(0, 30))}${first && first.length > 30 ? '…' : ''}${more}</span>`);
  } else if ((t.deps || []).length) {
    meta.push(`<span class="badge dep-met" title="All prerequisites are done">⛓ deps met</span>`);
  }
  if ((t.depsUnresolved || []).length) {
    meta.push(`<span class="badge err" title="Unresolved after: ${esc(t.depsUnresolved.join(' · '))} — edit the card or let the Sensei fix the link">⛓ unresolved dep</span>`);
  }
  // Bottleneck flag: this verdict (or an unmerged PR on an already-approved
  // card) is what queued work is waiting for.
  if (t.status === 'review' || isPrUnshipped(t)) {
    const held = pass.held(t.id);
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
}

// ---------- groups ----------
function groupWrap(colKey, name, members, pass) {
  const key = `${colKey}|${name}`;
  let rec = groupNodes.get(key);
  if (!rec) {
    const wrap = document.createElement('div');
    wrap.className = 'card-group';
    wrap.setAttribute('role', 'listitem');
    const head = document.createElement('div');
    head.className = 'card-group-head';
    head.tabIndex = 0;
    // not role="button" — the head CONTAINS a real queue <button>
    const chevron = document.createElement('span');
    chevron.className = 'card-group-chevron';
    chevron.textContent = '▾';
    const nameEl = document.createElement('span');
    nameEl.className = 'card-group-name';
    const countEl = document.createElement('span');
    countEl.className = 'card-group-count';
    head.append(chevron, nameEl, countEl);
    const cardsBox = document.createElement('div');
    cardsBox.className = 'card-group-cards';
    cardsBox.setAttribute('role', 'list');
    wrap.append(head, cardsBox);
    rec = { wrap, head, nameEl, countEl, cardsBox, queueBtn: null };
    groupNodes.set(key, rec);
  }
  rec.wrap.dataset.group = name;
  rec.wrap.dataset.col = colKey;
  rec.nameEl.textContent = name;
  const stats = pass.groupStats.get(name) || { total: 0, done: 0 };
  rec.countEl.textContent = `${stats.done}/${stats.total} done`;
  const collapsed = collapsedGroups.has(name);
  rec.wrap.classList.toggle('collapsed', collapsed);
  rec.head.setAttribute('aria-expanded', String(!collapsed));
  rec.head.setAttribute('aria-label',
    `Group ${name}, ${stats.done} of ${stats.total} done — press Enter to ${collapsed ? 'expand' : 'collapse'}`);
  const backlogCount = members.filter((t) => t.status === 'backlog').length;
  if (backlogCount) {
    if (!rec.queueBtn) {
      rec.queueBtn = document.createElement('button');
      rec.queueBtn.className = 'card-run card-group-queue';
      rec.queueBtn.dataset.act = 'queue-group';
      rec.queueBtn.textContent = '▶';
      rec.head.appendChild(rec.queueBtn);
    }
    const lbl = `Queue ${backlogCount} cards`;
    rec.queueBtn.title = lbl;
    rec.queueBtn.setAttribute('aria-label', lbl);
  } else if (rec.queueBtn) {
    rec.queueBtn.remove();
    rec.queueBtn = null;
  }
  return rec.wrap;
}

function toggleGroup(head) {
  const wrap = head.closest('.card-group');
  if (!wrap) return;
  const name = wrap.dataset.group;
  const isCollapsed = wrap.classList.toggle('collapsed');
  head.setAttribute('aria-expanded', String(!isCollapsed));
  if (isCollapsed) collapsedGroups.add(name); else collapsedGroups.delete(name);
  try { localStorage.setItem('kk-groups-collapsed', JSON.stringify([...collapsedGroups])); } catch {}
  if (isCollapsed) {
    // focus must not stay on a card that just became display:none
    const ae = document.activeElement;
    if (ae && ae !== head && wrap.contains(ae)) head.focus();
    // hidden cards are unreachable — keep them out of the tab order
    for (const c of wrap.querySelectorAll('.card')) c.tabIndex = -1;
  }
}

function queueGroup(btn) {
  const wrap = btn.closest('.card-group');
  if (!wrap) return;
  const name = wrap.dataset.group;
  const ordered = state.tasks
    .filter((t) => t.group === name && t.status === 'backlog' && matchesFilter(t))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  withBusy(btn, async () => {
    let queued = 0;
    const waitingOn = [];
    for (const t of ordered) {
      const r = await api(`/api/tasks/${t.id}/run`, { method: 'POST' });
      if (r.queued && r.waitingOn && r.waitingOn.length) waitingOn.push(t.title);
      else queued++;
    }
    toast(`queued ${queued}${waitingOn.length ? ` — ${waitingOn.length} waiting on deps` : ''}`, 'status');
  });
}

// ---------- event delegation (one listener set on #board, attached once) ----------
let boardWired = false;
function wireBoard(board) {
  if (boardWired) return;
  boardWired = true;

  board.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const actBtn = t.closest('[data-act]');
    if (actBtn && board.contains(actBtn)) {
      e.stopPropagation();
      if (actBtn.dataset.act === 'queue-group') queueGroup(actBtn);
      else {
        const card = actBtn.closest('.card');
        if (card) quickAction(actBtn, card.dataset.id, actBtn.dataset.act);
      }
      return;
    }
    const head = t.closest('.card-group-head');
    if (head && board.contains(head)) { toggleGroup(head); return; }
    if (t.closest('.pr-link')) { e.stopPropagation(); return; } // let the link navigate
    const card = t.closest('.card');
    if (card && board.contains(card)) openDrawer(card.dataset.id);
  });

  board.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const card = t.closest('.card');
    if (card) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(card.dataset.id); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        handleCardArrows(e, card, board);
      }
      return;
    }
    const head = t.closest('.card-group-head');
    if (head && head === t && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggleGroup(head);
    }
  });

  board.addEventListener('dragstart', (e) => {
    const card = e.target && e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;
    draggingNow = true;
    e.dataTransfer.setData('text/plain', card.dataset.id);
  });
  board.addEventListener('dragend', () => {
    draggingNow = false;
    if (renderQueued) { renderQueued = false; render(); }
  });
}

function quickAction(btn, id, act) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  withBusy(btn, async () => {
    if (act === 'run') {
      const prev = applyOptimistic(id, { status: 'queued' });
      const r = await api(`/api/tasks/${id}/run`, { method: 'POST' });
      if (!r || r.error) { rollbackOptimistic(id, prev); return; }
      if (r.queued && r.waitingOn && r.waitingOn.length) toast(`⛓ queued — waits on: ${r.waitingOn.join(' · ')}`, 'status');
      mergeTaskResponse(r);
    } else if (act === 'unqueue') {
      const prev = applyOptimistic(id, { status: 'backlog' });
      const r = await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'backlog' } });
      if (!r || r.error) rollbackOptimistic(id, prev);
      else mergeTaskResponse(r);
    } else if (act === 'approve') {
      if (!(await confirmDlg(`Approve "${t.title}" — stamp it Done?`, { confirmLabel: '✓ Approve' }))) return;
      const prev = applyOptimistic(id, { status: 'done' });
      const r = await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: 'done' } });
      if (!r || r.error) rollbackOptimistic(id, prev);
      else mergeTaskResponse(r);
    } else if (act === 'delete') {
      if (!(await confirmDlg('Delete this card and its transcript?', { confirmLabel: 'Delete', danger: true }))) return;
      // optimistic removal; the stale-echo guard keeps a pre-delete task event
      // from resurrecting it while the DELETE is in flight
      const i = state.tasks.findIndex((x) => x.id === id);
      const prev = state.tasks[i];
      optimistic.note(id, prev);
      state.tasks.splice(i, 1);
      render();
      const r = await api(`/api/tasks/${id}`, { method: 'DELETE' });
      if (!r || r.error) {
        state.tasks.splice(Math.min(i, state.tasks.length), 0, prev);
        optimistic.clear(id);
        render();
      }
    }
  });
}

// ---------- keyboard navigation (roving tabindex per column) ----------
function visibleCards(container) {
  return [...container.querySelectorAll('.card')].filter((c) => !c.closest('.card-group.collapsed'));
}

function applyRoving(colRec) {
  const all = [...colRec.body.querySelectorAll('.card')];
  if (!all.length) return;
  const visible = visibleCards(colRec.body);
  const pref = tabFocus.get(colRec.key);
  const chosen = visible.find((c) => c.dataset.id === pref) || visible[0] || null;
  for (const c of all) c.tabIndex = c === chosen ? 0 : -1;
}

function focusCard(el) {
  const colEl = el.closest('.column');
  if (colEl) {
    for (const c of colEl.querySelectorAll('.card')) c.tabIndex = c === el ? 0 : -1;
    tabFocus.set(colEl.dataset.status, el.dataset.id);
  }
  el.focus();
}

function handleCardArrows(e, card, board) {
  const colEl = card.closest('.column');
  if (!colEl) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const cards = visibleCards(colEl.querySelector('.col-body') || colEl);
    const i = cards.indexOf(card);
    const next = cards[e.key === 'ArrowUp' ? i - 1 : i + 1];
    if (next) { e.preventDefault(); focusCard(next); }
  } else {
    const cols = [...board.querySelectorAll('.column')];
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    // walk to the next column that actually has a focusable card (empty
    // columns and fully-collapsed ones are skipped)
    for (let ci = cols.indexOf(colEl) + step; ci >= 0 && ci < cols.length; ci += step) {
      const body = cols[ci].querySelector('.col-body') || cols[ci];
      const first = visibleCards(body)[0];
      if (first) { e.preventDefault(); focusCard(first); return; }
    }
  }
}

// ---------- focus bookkeeping across renders ----------
function captureFocus(board) {
  const ae = document.activeElement;
  if (!ae || !ae.closest || !board.contains(ae)) return null;
  const card = ae.closest('.card');
  if (card) {
    return {
      id: card.dataset.id,
      act: ae !== card && ae.dataset ? ae.dataset.act || null : null,
      link: ae !== card && ae.classList && ae.classList.contains('pr-link'),
    };
  }
  const head = ae.closest('.card-group-head');
  if (head) {
    const wrap = head.closest('.card-group');
    return { group: wrap && wrap.dataset.group, col: wrap && wrap.dataset.col };
  }
  return null;
}

function restoreFocus(info) {
  if (!info) return;
  let target = null;
  if (info.id) {
    const rec = cardNodes.get(info.id);
    if (rec && rec.el.isConnected && !rec.el._flipLeaving) {
      target = rec.el;
      if (info.act) {
        const btn = rec.el.querySelector(`[data-act="${info.act}"]`);
        if (btn) target = btn;
      } else if (info.link) {
        const a = rec.el.querySelector('.pr-link');
        if (a) target = a;
      }
      if (target === rec.el) focusCard(rec.el); // also fixes the roving tabindex
      else if (target.focus) target.focus();
      return;
    }
  }
  if (info.group) {
    const rec = groupNodes.get(`${info.col}|${info.group}`);
    if (rec) target = rec.head;
  }
  if (target && target.focus) target.focus();
}

// ---------- optimistic apply / rollback ----------
// Always REPLACE the task object (never mutate in place) so the WeakMap
// haystack cache and every revision compare see the change.
export function applyOptimistic(id, patch) {
  const i = state.tasks.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const prev = state.tasks[i];
  optimistic.note(id, prev);
  state.tasks[i] = { ...prev, ...patch, _optRev: (prev._optRev || 0) + 1 };
  render();
  return prev;
}

export function rollbackOptimistic(id, prev) {
  if (!prev) return;
  const i = state.tasks.findIndex((x) => x.id === id);
  if (i >= 0) state.tasks[i] = prev;
  else state.tasks.unshift(prev);
  optimistic.clear(id);
  render();
}

// A successful mutation response carries the full server-side task — fold it
// in so local state converges without waiting for the SSE echo.
export function mergeTaskResponse(r) {
  if (!r || typeof r !== 'object' || !r.id || !r.status) return;
  const i = state.tasks.findIndex((x) => x.id === r.id);
  if (i >= 0) {
    state.tasks[i] = r;
    optimistic.clear(r.id);
    render();
  }
}

// ---------- the render pass ----------
function recordPerf(t0) {
  const host = typeof window !== 'undefined' ? window : globalThis;
  host.__kkPerf = host.__kkPerf || { renders: [] };
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  host.__kkPerf.renders.push({ t: Date.now(), ms: Math.round((t1 - t0) * 100) / 100, cards: state.tasks.length });
  if (host.__kkPerf.renders.length > 500) host.__kkPerf.renders.splice(0, host.__kkPerf.renders.length - 500);
}

export function render() {
  if (draggingNow) { renderQueued = true; return; }
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  // task events fire every ~2s per running task; skip the pass entirely when
  // nothing render-relevant changed (cheap id:v fingerprint when v exists).
  const fingerprint = boardFingerprint();
  if (fingerprint === lastRenderFingerprint) return;
  lastRenderFingerprint = fingerprint;

  const board = $('#board');
  wireBoard(board);
  const flipBefore = flipEnabled() ? captureRects() : null;
  const focusInfo = captureFocus(board);

  updateHeaderStatus();
  board.classList.toggle('is-empty', !state.tasks.length);

  if (!state.tasks.length) {
    runReconcileJobs([{ container: board, targets: [emptyStateEl()] }], animateLeave);
    pruneCardNodes(new Set());
    pruneGroups(new Set());
    recordPerf(t0);
    return;
  }

  const pass = depPass(state.tasks);
  const seenCards = new Set();
  const seenGroups = new Set();
  const born = new Set();
  const jobs = [];
  const colEls = [];

  for (const col of COLUMNS) {
    const rec = columnEl(col);
    const colTasks = state.tasks
      .filter(matchesFilter)
      .filter((t) => (col.key === 'running' ? RUNNING_LIKE[t.status] : t.status === col.key))
      .sort((a, b) => pass.depth(a) - pass.depth(b) || (b.priority || 0) - (a.priority || 0));
    rec.countEl.textContent = colTasks.length;
    const cardWord = `${colTasks.length} card${colTasks.length === 1 ? '' : 's'}`;
    rec.el.setAttribute('aria-label', `${col.label} column, ${cardWord}`);
    rec.body.setAttribute('aria-label', `${col.label} cards`);

    const targets = [];
    if (!colTasks.length) {
      targets.push(rec.emptyEl);
    } else {
      // Ungrouped cards render as before; a card with a `group` joins a wrapper
      // positioned where the FIRST card of that group falls in the sort.
      const grouped = new Set();
      for (const t of colTasks) {
        if (!t.group) {
          targets.push(getCardEl(t, pass, born));
          seenCards.add(t.id);
          continue;
        }
        if (grouped.has(t.group)) continue;
        grouped.add(t.group);
        const members = colTasks.filter((x) => x.group === t.group);
        targets.push(groupWrap(col.key, t.group, members, pass));
        seenGroups.add(`${col.key}|${t.group}`);
        const grec = groupNodes.get(`${col.key}|${t.group}`);
        const memberEls = members.map((m) => {
          seenCards.add(m.id);
          return getCardEl(m, pass, born);
        });
        jobs.push({ container: grec.cardsBox, targets: memberEls });
      }
    }
    jobs.push({ container: rec.body, targets });
    colEls.push(rec.el);
  }
  jobs.push({ container: board, targets: colEls });
  runReconcileJobs(jobs, animateLeave);
  for (const col of COLUMNS) applyRoving(colNodes.get(col.key)); // after the moves
  pruneCardNodes(seenCards);
  pruneGroups(seenGroups);
  restoreFocus(focusInfo);
  playFlip(flipBefore, born);
  recordPerf(t0);
}

// Cards not rendered this pass: filtered-out tasks keep their (detached) node
// cached for a cheap re-entry; tasks that no longer exist are dropped for good.
function pruneCardNodes(seen) {
  for (const [id, rec] of cardNodes) {
    if (seen.has(id)) continue;
    if (state.tasks.some((t) => t.id === id)) {
      if (rec.el.parentNode && !rec.el._flipLeaving) rec.el.remove();
    } else {
      cardNodes.delete(id);
    }
  }
}

function pruneGroups(seen) {
  for (const [key, rec] of groupNodes) {
    if (seen.has(key)) continue;
    if (rec.wrap.parentNode) rec.wrap.remove();
    groupNodes.delete(key);
  }
}

let emptyEl = null;
function emptyStateEl() {
  if (emptyEl) return emptyEl;
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
  emptyEl = empty;
  return empty;
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

export async function loadTasks() {
  // Conditional refetch: once a board version is known (SSE task.v or an
  // X-Board-Version header), ask only for changes. A server without support
  // ignores ?v= and answers with the full body and no header — boardV then
  // stays 0 and every call takes the classic path below.
  if (state.boardV) {
    try {
      const res = await fetch(`/api/tasks?v=${state.boardV}`);
      if (res.status === 304) return true; // board unchanged
      if (res.status === 401) { location.href = '/login'; return false; }
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          state.tasks = data;
          const hdr = res.headers.get('X-Board-Version');
          state.boardV = hdr ? parseInt(hdr, 10) || 0 : 0;
          render();
          return true;
        }
      }
      // unexpected response — fall through to the classic path
    } catch { /* fall through to the classic path */ }
  }
  const r = await api('/api/tasks');
  if (!Array.isArray(r)) return false; // error already toasted; keep the last good board
  state.tasks = r;
  render();
  return true;
}

// Test hook: module-level caches survive across tests in one process.
export function __resetBoardForTests() {
  cardNodes.clear();
  colNodes.clear();
  groupNodes.clear();
  stampedSeals.clear();
  tabFocus.clear();
  lastRenderFingerprint = null;
  draggingNow = false;
  renderQueued = false;
  boardWired = false;
  emptyEl = null;
}
