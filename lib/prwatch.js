// PR watcher: a periodic sweep over review cards that opened PRs.
//   MERGED      → card moves to Done (verdict "PR merged") + notification
//   CLOSED      → noted once on the card transcript
//   CONFLICTING → auto-spawn a fix card: a fresh agent run inside the original
//                 worktree that merges the base branch, resolves, and pushes
//                 (max 2 attempts per PR, one active fixer at a time)
const fs = require('fs');
const crypto = require('crypto');
const { state, save, getTask, appendTranscript } = require('./store');
const { notify } = require('./notify');
const { findWorktree, run } = require('./prflow');
const runner = require('./runner');

let broadcast = () => {};
function setBroadcaster(fn) {
  broadcast = fn;
}

function log(task, kind, text) {
  appendTranscript(task.id, { kind, text });
  broadcast({ type: 'output', taskId: task.id, entry: { kind, text } });
}

function watchMinutes() {
  const n = parseInt(state.settings.prWatchMin, 10);
  return Number.isInteger(n) ? Math.max(0, Math.min(120, n)) : 10;
}
function autoFixEnabled() {
  return state.settings.prWatchAutoFix !== false;
}

async function prInfo(url) {
  const res = await run('gh', ['pr', 'view', url, '--json', 'state,mergeable'], undefined, 30_000);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.out);
  } catch {
    return null;
  }
}

function activeFixer(parentId) {
  return state.tasks.find(
    (x) => x.fixesTaskId === parentId && ['backlog', 'queued', 'running', 'stopping'].includes(x.status)
  );
}

async function maybeFix(task) {
  if (require('./cooldown').active()) return; // no auto-fixes during cooldown
  if ((task.conflictFixes || 0) >= 2) {
    if (!task.conflictGaveUp) {
      task.conflictGaveUp = true;
      save();
      log(task, 'error', 'PR watch: still conflicting after 2 fix attempts — resolve manually');
      notify('Kungfu Kanban — PR needs you', `${task.title} · conflicts persist after 2 auto-fixes`, task.prUrl);
    }
    return;
  }
  if (activeFixer(task.id)) return;

  const name = `kanban-${task.id.slice(0, 8)}`;
  const wt = await findWorktree(task.cwd, name);
  if (!wt || !fs.existsSync(wt.path)) {
    log(task, 'error', `PR watch: conflicts detected but worktree "${name}" is gone — resolve manually`);
    task.conflictGaveUp = true;
    save();
    return;
  }
  const base = await run('git', ['branch', '--show-current'], task.cwd);
  const baseBranch = base.ok && base.out ? base.out : 'main';

  const fix = {
    id: crypto.randomUUID(),
    title: `Fix PR conflicts: ${task.title}`.slice(0, 200),
    prompt: [
      `You are in the git worktree ${wt.path} on branch ${wt.branch}. Its open PR (${task.prUrl}) now has merge conflicts with the base branch ${baseBranch}.`,
      `1. git fetch origin`,
      `2. git merge origin/${baseBranch}`,
      `3. Resolve every conflict faithfully — preserve BOTH this branch's feature and the base branch's changes. Read the surrounding code; do not discard either side blindly.`,
      `4. Sanity-check what you changed (e.g. node --check on edited .js files).`,
      `5. Commit the merge and push the branch to origin. Do NOT open a new PR — pushing updates the existing one.`,
    ].join('\n'),
    cwd: wt.path,
    model: task.model && task.model !== 'default' ? task.model : 'sonnet',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    skills: [],
    skillsAuto: false,
    agent: null,
    worktree: false,
    openPr: false,
    priority: 2,
    acceptanceCriteria: 'The PR no longer shows merge conflicts; both the feature and base-branch changes survive; the branch is pushed.',
    status: 'backlog',
    createdAt: new Date().toISOString(),
    createdBy: 'auto',
    fixesTaskId: task.id,
    retries: 0,
    sessionId: null, error: null, resultText: null, stats: null,
  };
  state.tasks.unshift(fix);
  task.conflictFixes = (task.conflictFixes || 0) + 1;
  save();
  broadcast({ type: 'task', task: fix });
  log(task, 'pr', `PR watch: conflicts with ${baseBranch} — launched fix card (attempt ${task.conflictFixes}/2)`);
  runner.startTask(fix.id);
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const t of [...state.tasks]) {
      if (t.status !== 'review' || !t.prUrl) continue;
      const info = await prInfo(t.prUrl);
      if (!info) continue;
      if (info.state === 'MERGED') {
        t.status = 'done';
        t.managerVerdict = 'PR merged';
        save();
        broadcast({ type: 'task', task: t });
        log(t, 'pr', 'PR watch: PR merged — card shipped');
        notify('Kungfu Kanban — PR merged', t.title, t.prUrl);
      } else if (info.state === 'CLOSED') {
        if (!t.prClosedNoted) {
          t.prClosedNoted = true;
          save();
          log(t, 'pr', 'PR watch: PR was closed without merging');
        }
      } else if (info.mergeable === 'CONFLICTING' && autoFixEnabled()) {
        await maybeFix(t);
      }
    }
  } finally {
    sweeping = false;
  }
}

let timer = null;
function applyInterval() {
  clearInterval(timer);
  const min = watchMinutes();
  if (min > 0) timer = setInterval(sweep, min * 60_000);
}

module.exports = { sweep, applyInterval, setBroadcaster };
