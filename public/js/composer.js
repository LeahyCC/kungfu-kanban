/* The composer — what "＋ New cards" opens, and the only way in that isn't the
 * Sensei or the inbox. One prompt box with the settings that matter (repo,
 * model, effort, permissions) and three ways out — sharpen the wording, launch
 * it as one card, or hand it to the Sensei to break into several. Everything
 * here is a shortcut to machinery that already exists; nothing new is
 * persisted.
 *
 * It builds into #composerSlot exactly once and stays there: the ids below are
 * global, so a second copy (the old empty-board mount) would shadow this one. */

import { state } from './state.js';
import { $, fillSelect } from './util.js';
import { api, toast, withBusy } from './api.js';

const KEY = 'kk-composer'; // last-used settings, so the box remembers you

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function savePrefs(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {}
}

function currentPrefs() {
  return {
    cwd: $('#cmpRepo').value,
    model: $('#cmpModel').value,
    effort: $('#cmpEffort').value,
    permissionMode: $('#cmpPerm').value,
    worktree: $('#cmpWorktree').checked,
  };
}

// Build + wire once, into #composerSlot. Everything after that is show/hide,
// so a half-typed prompt survives closing the modal.
let built = false;
let returnFocus = null;

export function openComposer() {
  if (!built) {
    built = true;
    $('#composerSlot').appendChild(buildComposer());
    mountComposer();
  }
  returnFocus = document.activeElement;
  $('#composerBackdrop').classList.remove('hidden');
  $('#cmpPrompt').focus();
}

export function closeComposer() {
  $('#composerBackdrop').classList.add('hidden');
  if (returnFocus) { try { returnFocus.focus(); } catch {} returnFocus = null; }
}

$('#newCardsBtn').addEventListener('click', () => openComposer());
$('#composerBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeComposer();
});

function buildComposer() {
  const el = document.createElement('div');
  el.className = 'composer';
  el.innerHTML = `
    <h3 id="cmpTitle">What needs doing?</h3>
    <p class="cmp-lead">Describe the work — an agent picks it up with nothing but this text, so be specific.
      Or say <span class="cmp-cli">create a kungfu todo for…</span> in any Claude Code session and cards land here on their own.</p>
    <textarea id="cmpPrompt" rows="5" placeholder="Fix the flaky auth test in the login suite — it fails about one run in five on CI"
      aria-label="Describe the work"></textarea>
    <div class="cmp-row">
      <label>Project <select id="cmpRepo" aria-label="Project"></select></label>
      <label>Model <select id="cmpModel" aria-label="Model"></select></label>
      <label>Effort <select id="cmpEffort" aria-label="Effort"></select></label>
      <label>Permissions <select id="cmpPerm" aria-label="Permissions"></select></label>
      <label class="cmp-check" title="Run in an isolated git worktree and open a PR when it finishes">
        <input type="checkbox" id="cmpWorktree" /> worktree + PR</label>
    </div>
    <div class="cmp-actions">
      <button type="button" id="cmpImprove" class="ghost"
        title="Rewrite what's in the box: sharper, self-contained, with acceptance criteria. Changes the text only — nothing is created.">✨ Improve prompt</button>
      <button type="button" id="cmpDraft" class="ghost"
        title="Hand it to the Sensei to break into several cards with dependencies">⇪ Split into cards</button>
      <span class="cmp-spacer"></span>
      <button type="button" id="cmpCancel" class="ghost" title="Close without creating anything">Cancel</button>
      <button type="button" id="cmpCreate" class="primary" title="Create the card and start it now">▶ Create &amp; run</button>
      <button type="button" id="cmpQueue" class="ghost" title="Create it in Backlog — nothing runs until you launch it">＋ Add to backlog</button>
    </div>
    <p class="cmp-undo footnote hidden" id="cmpUndo"></p>`;
  return el;
}

// Fill the selects from /api/config once the node is in the document.
function mountComposer() {
  const cfg = state.config || {};
  const prefs = readPrefs();
  const repos = cfg.repos || [];
  const repoSel = $('#cmpRepo');
  repoSel.innerHTML = '';
  const none = document.createElement('option');
  none.value = cfg.settings && cfg.settings.defaultCwd ? cfg.settings.defaultCwd : '';
  none.textContent = cfg.settings && cfg.settings.defaultCwd
    ? `default (${cfg.settings.defaultCwd.split('/').pop()})`
    : '(no project)';
  repoSel.appendChild(none);
  for (const r of repos) {
    const o = document.createElement('option');
    o.value = r.path;
    o.textContent = r.name;
    repoSel.appendChild(o);
  }
  if (prefs.cwd && [...repoSel.options].some((o) => o.value === prefs.cwd)) repoSel.value = prefs.cwd;

  fillSelect($('#cmpModel'), cfg.models || ['default'], prefs.model || 'default');
  fillSelect($('#cmpEffort'), cfg.efforts || ['default'], prefs.effort || 'default');
  fillSelect($('#cmpPerm'), cfg.permissionModes || ['acceptEdits'],
    prefs.permissionMode || (cfg.settings && cfg.settings.defaultPermissionMode) || 'acceptEdits');
  // mirror the card modal: 'default' says what it will actually resolve to
  const s = cfg.settings || {};
  $('#cmpModel').options[0].text = s.defaultModel ? `default (${s.defaultModel})` : 'default (CLI picks)';
  $('#cmpEffort').options[0].text = s.defaultEffort ? `default (${s.defaultEffort})` : 'default (CLI picks)';
  $('#cmpWorktree').checked = prefs.worktree !== false && !!prefs.worktree;

  for (const id of ['#cmpRepo', '#cmpModel', '#cmpEffort', '#cmpPerm', '#cmpWorktree']) {
    $(id).addEventListener('change', () => savePrefs(currentPrefs()));
  }
  $('#cmpImprove').addEventListener('click', (e) => withBusy(e.target, improve));
  $('#cmpDraft').addEventListener('click', handOffToImport);
  $('#cmpCancel').addEventListener('click', () => closeComposer());
  $('#cmpCreate').addEventListener('click', (e) => withBusy(e.target, () => create(true)));
  $('#cmpQueue').addEventListener('click', (e) => withBusy(e.target, () => create(false)));
  // ⌘↵ from the box is the fast path
  $('#cmpPrompt').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('#cmpCreate').click(); }
  });
}

// Rewrite the text in place. The previous version stays one click away —
// an AI rewrite you can't undo is a trap when it drifts from what you meant.
let lastText = null;
async function improve() {
  const box = $('#cmpPrompt');
  const text = box.value.trim();
  if (!text) { toast('Write something first — improve sharpens what is already there.', 'status'); box.focus(); return; }
  const r = await api('/api/prompt/improve', { method: 'POST', body: { text, repoPath: $('#cmpRepo').value || null } });
  if (!r || r.error || !r.text) return;
  lastText = text;
  box.value = r.text;
  box.focus();
  const undo = $('#cmpUndo');
  undo.textContent = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost mini';
  btn.textContent = '↶ undo improve';
  btn.addEventListener('click', () => {
    if (lastText === null) return;
    box.value = lastText;
    lastText = null;
    undo.classList.add('hidden');
    box.focus();
  });
  undo.append('Rewritten. ', btn);
  undo.classList.remove('hidden');
}

// First line becomes the title; the whole text stays the prompt.
function titleFor(text) {
  const first = text.split('\n').find((l) => l.trim()) || text;
  return first.trim().replace(/^[-*#\s]+/, '').slice(0, 120) || 'Untitled card';
}

async function create(run) {
  const text = $('#cmpPrompt').value.trim();
  if (!text) { toast('Describe the work first.', 'status'); $('#cmpPrompt').focus(); return; }
  const p = currentPrefs();
  savePrefs(p);
  const task = await api('/api/tasks', {
    method: 'POST',
    body: {
      title: titleFor(text),
      prompt: text,
      cwd: p.cwd || undefined,
      model: p.model,
      effort: p.effort,
      permissionMode: p.permissionMode,
      worktree: p.worktree,
      openPr: p.worktree, // a worktree card that never opens a PR strands its work
    },
  });
  if (!task || task.error || !task.id) return;
  if (run) {
    const r = await api(`/api/tasks/${task.id}/run`, { method: 'POST' });
    if (r && r.queued) toast('Card created — queued behind the current guard.', 'status');
  }
  $('#cmpPrompt').value = '';
  $('#cmpUndo').classList.add('hidden');
  closeComposer();
  const { loadTasks } = await import('./board.js');
  await loadTasks();
}

// The import modal already does multi-card drafting properly — carry the text
// across rather than reimplementing the flow here. modals.js is imported late
// for the same reason board.js is: statically it would drag the whole modal
// graph (appearance, chips) into anything that merely renders the board.
async function handOffToImport() {
  const text = $('#cmpPrompt').value.trim();
  const repo = $('#cmpRepo').value;
  closeComposer(); // one backdrop at a time
  const { openImportModal } = await import('./modals.js');
  openImportModal();
  if (!text) return;
  const req = $('#draftPrompt');
  if (req) { req.value = text; req.focus(); }
  // carry the chosen project too, so the draft grounds itself in the same repo
  const repoSel = $('#draftRepo');
  if (repoSel && repo && [...repoSel.options].some((o) => o.value === repo)) repoSel.value = repo;
}
