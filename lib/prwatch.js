// PR watcher: a periodic sweep over review cards that opened PRs.
//   MERGED      → card moves to Done (verdict "PR merged") + notification
//   CLOSED      → noted once on the card transcript
//   CONFLICTING → auto-spawn a fix card: a fresh agent run inside the original
//                 worktree that merges the base branch, resolves, and pushes
//                 (max 2 attempts per PR, one active fixer at a time)
//   CI checks   → every sweep stores the check rollup on the card (prChecks:
//                 base, passing/failing/pending counts, failed names, wrongBase)
//                 so the board badges red PRs and the Sensei won't approve them;
//                 transitions (new failure, recovery) log + notify once.
const fs = require('fs');
const crypto = require('crypto');
const { state, save, getTask, appendTranscript } = require('./store');
const { notify } = require('./notify');
const { findWorktree, run } = require('./prflow');
const runner = require('./runner');
const errlog = require('./errlog');
const { broadcast } = require('./bus');

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
  const res = await run('gh', ['pr', 'view', url, '--json', 'state,mergeable,baseRefName,isDraft,reviewDecision,statusCheckRollup'], undefined, 30_000);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.out);
  } catch {
    return null;
  }
}

// gh's statusCheckRollup mixes CheckRun {name,status,conclusion} and legacy
// StatusContext {context,state} items — normalize both into pass/fail/pending.
function summarizeChecks(rollup) {
  const out = { passing: 0, failing: 0, pending: 0, failed: [] };
  for (const c of rollup || []) {
    const name = c.name || c.context || 'check';
    if (c.__typename === 'StatusContext') {
      const s = (c.state || '').toUpperCase();
      if (s === 'SUCCESS') out.passing++;
      else if (s === 'FAILURE' || s === 'ERROR') { out.failing++; out.failed.push(name); }
      else out.pending++;
    } else if ((c.status || '').toUpperCase() !== 'COMPLETED') {
      out.pending++;
    } else {
      const con = (c.conclusion || '').toUpperCase();
      if (con === 'SUCCESS' || con === 'NEUTRAL' || con === 'SKIPPED') out.passing++;
      else { out.failing++; out.failed.push(name); }
    }
  }
  out.failed = out.failed.slice(0, 5);
  return out;
}

// Store the rollup on the card; log + notify only on transitions so a red PR
// doesn't renotify every sweep. Returns nothing — state lives on the task.
function trackChecks(t, info) {
  const checks = summarizeChecks(info.statusCheckRollup);
  const wrongBase = !!(t.prBaseBranch && info.baseRefName && info.baseRefName !== t.prBaseBranch);
  const key = [info.baseRefName, checks.failing, checks.pending, checks.passing, checks.failed.join(','), wrongBase].join('|');
  const prev = t.prChecks || null;
  if (prev && prev.key === key) return;
  // Notify only when the failure set itself changes, not on every check that
  // completes — otherwise a PR with one red check pings once per green check
  // finishing around it.
  const failedChanged = !prev || prev.wrongBase !== wrongBase || (prev.failed || []).join(',') !== checks.failed.join(',');
  t.prChecks = { base: info.baseRefName, ...checks, wrongBase, key, at: new Date().toISOString() };
  save();
  broadcast({ type: 'task', task: t });
  if (!failedChanged) return;
  // A branch-guard check ("source-must-be-staging" and kin) failing means the
  // PR targets the wrong base even when the card never declared one — that's
  // an operational error the tracker owns, distinct from red tests.
  const guardFail = checks.failed.find((n) => /branch|base|staging/i.test(n));
  if (checks.failing > 0) {
    const why = checks.failed.join(' · ') + (wrongBase ? ` · PR targets ${info.baseRefName}, card wants ${t.prBaseBranch}` : '');
    log(t, 'error', `PR watch: ${checks.failing} failing check(s) — ${why}`);
    notify('Kungfu Kanban — PR checks failing', `${t.title} · ${checks.failed[0] || 'CI red'}`, t.prUrl);
    if (wrongBase || guardFail) {
      errlog.capture('wrong-base', {
        taskId: t.id, taskTitle: t.title,
        text: `PR targets ${info.baseRefName}${t.prBaseBranch ? ` but the card wants ${t.prBaseBranch}` : ''}${guardFail ? ` — branch guard "${guardFail}" failing` : ''}`,
        detail: t.prUrl,
      });
    } else {
      errlog.capture('ci-failing', {
        taskId: t.id, taskTitle: t.title,
        text: `${checks.failing} failing check(s): ${checks.failed.join(' · ')}`,
        detail: t.prUrl,
      });
    }
  } else if (wrongBase) {
    log(t, 'error', `PR watch: PR base is ${info.baseRefName} but the card wants ${t.prBaseBranch} — retarget it (gh pr edit --base ${t.prBaseBranch}) or close and re-run`);
    notify('Kungfu Kanban — PR targets wrong branch', `${t.title} · ${info.baseRefName} ≠ ${t.prBaseBranch}`, t.prUrl);
    errlog.capture('wrong-base', {
      taskId: t.id, taskTitle: t.title,
      text: `PR targets ${info.baseRefName} but the card wants ${t.prBaseBranch}`,
      detail: t.prUrl,
    });
  } else if (checks.pending === 0) {
    // green on the right base — whatever CI/base entries this card had are history
    errlog.resolveTask(t.id, ['wrong-base', 'ci-failing']);
    if (prev && prev.failing > 0) log(t, 'pr', 'PR watch: checks recovered — all green');
  }
}

function activeFixer(parentId) {
  return state.tasks.find(
    (x) => x.fixesTaskId === parentId && ['backlog', 'queued', 'running', 'stopping'].includes(x.status)
  );
}

async function maybeFix(task, info) {
  if (require('./cooldown').active()) return; // no auto-fixes during cooldown
  if ((task.conflictFixes || 0) >= 2) {
    if (!task.conflictGaveUp) {
      task.conflictGaveUp = true;
      save();
      log(task, 'error', 'PR watch: still conflicting after 2 fix attempts — resolve manually');
      notify('Kungfu Kanban — PR needs you', `${task.title} · conflicts persist after 2 auto-fixes`, task.prUrl);
      errlog.capture('pr-conflict', { taskId: task.id, taskTitle: task.title, text: 'PR still conflicting after 2 auto-fix attempts — needs a human merge', detail: task.prUrl });
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
    errlog.capture('pr-conflict', { taskId: task.id, taskTitle: task.title, text: 'PR has conflicts but its worktree is gone — resolve manually', detail: task.prUrl });
    return;
  }
  const baseBranch = info.baseRefName || task.prBaseBranch || 'main';

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
      if (!t.prUrl || t.prClosedNoted) continue;
      // Review cards are watched as usual; a done card whose PR never merged
      // still needs watching so an external merge releases its dependents.
      if (t.status !== 'review' && !(t.status === 'done' && !t.prMergedAt)) continue;
      const info = await prInfo(t.prUrl);
      if (!info) {
        t.prWatchFails = (t.prWatchFails || 0) + 1;
        if (t.prWatchFails === 3) {
          save();
          log(t, 'error', 'PR watch: gh has failed 3 sweeps in a row for this PR — merges and CI won\'t be detected until it recovers');
          errlog.capture('pr-flow', { taskId: t.id, taskTitle: t.title, text: 'PR watch cannot reach gh for this PR (missing/unauthed/rate-limited/deleted) — merges and CI updates are blind', detail: t.prUrl });
        }
        continue;
      }
      if (t.prWatchFails) {
        t.prWatchFails = 0;
        errlog.resolveTask(t.id, ['pr-flow']);
      }
      if (info.state === 'MERGED') {
        t.status = 'done';
        t.managerVerdict = 'PR merged';
        t.prMergedAt = new Date().toISOString();
        errlog.resolveTask(t.id); // shipped — nothing about this card is open anymore
        save();
        broadcast({ type: 'task', task: t });
        log(t, 'pr', 'PR watch: PR merged — card shipped');
        notify('Kungfu Kanban — PR merged', t.title, t.prUrl);
        runner.pumpQueue(); // the merge may free dependent cards
      } else if (info.state === 'CLOSED') {
        if (!t.prClosedNoted) {
          t.prClosedNoted = true;
          save();
          log(t, 'pr', 'PR watch: PR was closed without merging');
        }
      } else {
        trackChecks(t, info);
        if (info.mergeable === 'CONFLICTING' && autoFixEnabled()) {
          await maybeFix(t, info);
        }
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

// One-time boot backfill: cards done before prMergedAt existed carry only the
// legacy managerVerdict prose. Stamp them so deps.unmet doesn't re-block
// dependents that already released under the old semantics.
function backfillMergedAt() {
  let changed = false;
  for (const t of state.tasks) {
    if (t.status === 'done' && t.managerVerdict === 'PR merged' && !t.prMergedAt) {
      t.prMergedAt = t.finishedAt || new Date().toISOString();
      changed = true;
    }
  }
  if (changed) save();
}

module.exports = { sweep, applyInterval, summarizeChecks, backfillMergedAt };
