// PR watcher: a periodic sweep over review cards that opened PRs.
//   MERGED      → card moves to Done (verdict "PR merged") + notification
//   CLOSED      → noted once on the card transcript
//   CONFLICTING → auto-spawn a fix card: a fresh agent run inside the original
//                 worktree that merges the base branch, resolves, and pushes
//                 (max 2 attempts per PR, one active fixer at a time)
//   CI checks   → every sweep stores the check rollup on the card (prChecks:
//                 base, passing/failing/pending counts, failed names, wrongBase,
//                 conflicting, noCi) so the board badges red PRs and the Sensei
//                 won't approve them; transitions (new failure, recovery) log +
//                 notify once. The sweep is the automation loop's heartbeat:
//                 - checks still running → re-poll in 60s (not the full interval)
//                 - settle red on a clean PR → resume the card's own session to
//                   fix CI (max 2 attempts, no Sensei retry burned)
//                 - decision-ready (green, red-after-fixes, or a no-CI repo
//                   past the grace window) → re-invoke the Sensei for the
//                   merge/reject verdict — the finish-time review ran before
//                   CI had reported anything.
const fs = require('fs');
const crypto = require('crypto');
const { state, save, getTask, appendTranscript, touch } = require('./store');
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

// A PR with zero reported checks this long after we started watching, on a
// repo where GitHub has computed mergeability, has no CI at all — stop
// waiting for checks that will never come and let the Sensei judge the diff.
const NO_CI_GRACE_MS = 10 * 60_000;

// How long the 60s fast poll stays on a single PR before falling back to the
// normal interval — a stuck required check must not poll gh indefinitely.
const HOT_POLL_MAX_MS = 45 * 60_000;

// Store the rollup on the card; log + notify only on transitions so a red PR
// doesn't renotify every sweep. Returns true when the PR just became
// decision-ready (checks settled, the settled outcome changed, or the repo
// turned out to have no CI) so the sweep can act on the verdict.
function trackChecks(t, info) {
  const checks = summarizeChecks(info.statusCheckRollup);
  const wrongBase = !!(t.prBaseBranch && info.baseRefName && info.baseRefName !== t.prBaseBranch);
  const conflicting = info.mergeable === 'CONFLICTING';
  const prev = t.prChecks || null;
  const firstSeenAt = (prev && prev.firstSeenAt) || new Date().toISOString();
  const reported = checks.passing + checks.failing + checks.pending > 0;
  const noCi = !reported && !!info.mergeable && info.mergeable !== 'UNKNOWN'
    && Date.now() - Date.parse(firstSeenAt) >= NO_CI_GRACE_MS;
  const key = [info.baseRefName, checks.failing, checks.pending, checks.passing, checks.failed.join(','), wrongBase, conflicting, noCi].join('|');
  if (prev && prev.key === key) return false;
  // Notify only when the failure set itself changes, not on every check that
  // completes — otherwise a PR with one red check pings once per green check
  // finishing around it.
  const settled = checks.pending === 0 && reported;
  // Compare settled-to-settled, not against the raw previous sweep: a new CI
  // attempt on a red PR passes through pending (failed=[]) and re-settles with
  // the same red set, and comparing raw prev state re-fired capture/notify/
  // ready on every attempt. settledFailed carries the last settled outcome
  // through pending phases; null means never settled. Cards persisted before
  // the field derive it from prev when prev was itself settled.
  const prevSettledFailed = !prev ? null
    : prev.settledFailed !== undefined ? prev.settledFailed
    : (prev.pending === 0 && (prev.passing || 0) + (prev.failing || 0) > 0) ? (prev.failed || []).join(',')
    : null;
  const failedChanged = !prev || prev.wrongBase !== wrongBase
    || (settled && checks.failed.join(',') !== prevSettledFailed);
  const wasReady = !!prev && (prev.noCi || prevSettledFailed != null);
  const ready = (settled || noCi) && (!wasReady || failedChanged);
  t.prChecks = { base: info.baseRefName, ...checks, wrongBase, conflicting, noCi, firstSeenAt, key,
    settledFailed: settled ? checks.failed.join(',') : prevSettledFailed, at: new Date().toISOString() };
  save();
  broadcast({ type: 'task', task: t });
  if (conflicting && (!prev || !prev.conflicting)) {
    log(t, 'error', `PR watch: merge conflicts with ${info.baseRefName || 'the base branch'}${autoFixEnabled() ? '' : ' — auto-fix is off, resolve manually'}`);
    if (!autoFixEnabled()) notify('Kungfu Kanban — PR has conflicts', t.title, t.prUrl);
  }
  if (!failedChanged) return ready;
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
    if (prevSettledFailed) log(t, 'pr', 'PR watch: checks recovered — all green');
  }
  return ready;
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
      touch(task); // save-only mutation — no type:'task' broadcast stamps this one
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
    touch(task); // save-only mutation — no type:'task' broadcast stamps this one
    save();
    errlog.capture('pr-conflict', { taskId: task.id, taskTitle: task.title, text: 'PR has conflicts but its worktree is gone — resolve manually', detail: task.prUrl });
    return;
  }
  // The sweep may be several seconds stale by the time we're about to spawn a
  // fixer — re-check right before committing so we don't fix an already-moot PR.
  const fresh = await prInfo(task.prUrl);
  if (!fresh || fresh.state !== 'OPEN' || fresh.mergeable !== 'CONFLICTING') return;

  const baseBranch = fresh.baseRefName || task.prBaseBranch || 'main';

  const fix = {
    id: crypto.randomUUID(),
    title: `Fix PR conflicts: ${task.title}`.slice(0, 200),
    prompt: [
      `You are in the git worktree ${wt.path} on branch ${wt.branch}. Its open PR (${task.prUrl}) may have merge conflicts with the base branch ${baseBranch}.`,
      `1. git fetch origin`,
      `2. gh pr view ${task.prUrl} --json state,mergeable`,
      `3. If the PR is MERGED or CLOSED, or mergeable is not CONFLICTING, push nothing — reply that it's a no-op and stop.`,
      `4. Otherwise: git merge origin/${baseBranch}`,
      `5. Resolve every conflict faithfully — preserve BOTH this branch's feature and the base branch's changes. Read the surrounding code; do not discard either side blindly.`,
      `6. Sanity-check what you changed (e.g. node --check on edited .js files).`,
      `7. Commit the merge and push the branch to origin. Do NOT open a new PR — pushing updates the existing one.`,
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
  touch(task); // the broadcast below is for the fix card, not this one
  save();
  broadcast({ type: 'task', task: fix });
  log(task, 'pr', `PR watch: conflicts with ${baseBranch} — launched fix card (attempt ${task.conflictFixes}/2)`);
  runner.startTask(fix.id);
}

// Red CI: resume the card's OWN session with the failing-check details — same
// context, same branch, same PR, no Sensei retry burned. Two attempts per PR,
// then the Sensei/human takes over. Mirrors the conflict auto-fixer.
async function maybeFixCi(t, checks) {
  if (require('./cooldown').active()) return false;
  if ((t.ciFixes || 0) >= 2) {
    if (!t.ciFixGaveUp) {
      t.ciFixGaveUp = true;
      touch(t); // save-only mutation — no type:'task' broadcast stamps this one
      save();
      log(t, 'error', 'PR watch: checks still failing after 2 auto CI fixes — handing off to review');
    }
    return false;
  }
  if (activeFixer(t.id)) return false;
  // Same worktree-liveness bar as the conflict fixer: the session lives there.
  const wt = await findWorktree(t.cwd, `kanban-${t.id.slice(0, 8)}`);
  if (!wt || !fs.existsSync(wt.path)) return false;
  const res = runner.followUp(t.id, [
    `Your PR ${t.prUrl} has failing checks: ${checks.failed.join(' · ') || '(names unavailable)'}.`,
    `1. Inspect why: \`gh pr checks ${t.prUrl}\`, then \`gh run view <run-id> --log-failed\` for each failing run.`,
    `2. If the failures are CI infrastructure — billing/quota errors, runners that never started, jobs cancelled before running — no code change can fix them: reply explaining exactly that and stop. Do not touch the code.`,
    `3. Otherwise fix the root cause on this branch, run the relevant tests/linters locally, commit, and push. Do NOT open a new PR — pushing updates the existing one.`,
  ].join('\n'));
  if (res.error) return false;
  t.ciFixes = (t.ciFixes || 0) + 1;
  touch(t); // save-only mutation — no type:'task' broadcast stamps this one
  save();
  log(t, 'pr', `PR watch: failing checks — resuming the card's session to fix CI (attempt ${t.ciFixes}/2)`);
  return true;
}

let sweeping = false;
let hotTimer = null;

// Bounded promise pool. prInfo() is 0.5–2s of gh latency per card, and the
// sweep used to await it serially — 10 watched PRs meant 10× that. Four
// concurrent workers keep a sweep near the slowest single call without
// hammering gh. Result order matches input order.
const SWEEP_CONCURRENCY = 4;
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Backstop for a review card whose PR URL never landed on it: the agent opened
// the PR itself under its own branch name, so the card's own `gh pr create`
// came back "already exists" and (before v1.9.1) dropped the URL. Such a card
// is invisible to the sweep below, so merging its PR never ships it — it sits
// in review forever holding up every dependent. The card's worktree knows its
// branch, and GitHub knows that branch's PR, so ask.
const ADOPT_TRIES = 3;

function needsPrUrl(t) {
  if (t.prUrl || !t.openPr || !t.worktree || !t.cwd) return false;
  if (t.error) return false; // a failed run never reaches the PR flow — nothing to find
  if ((t.prAdoptMisses || 0) >= ADOPT_TRIES) return false; // looked enough; the repair hatch is the human's
  // Exactly the set the sweep watches: a card awaiting a verdict, and a shipped
  // card whose PR has not been seen to merge. The second matters because a card
  // approved to done with an untracked PR counts as shipped to deps.js and
  // releases its dependents even when nothing ever landed.
  return t.status === 'review' || (t.status === 'done' && !t.prMergedAt);
}

// Branch NAMES are the agent's choice and can repeat across cards, so a hit on
// the branch only belongs to THIS card if it was opened after the card existed.
// Without that, a stale merged PR from whoever used the name first would mark
// unshipped work done and release its dependents. The floor is the card's
// createdAt, NOT startedAt: a retry or follow-up relaunches the card long after
// its agent opened the PR, and that PR is still this card's.
function prBelongsTo(pr, t) {
  if (!pr || !String(pr.url || '').startsWith('https://')) return false;
  if (!t.createdAt || !pr.createdAt) return true;
  return Date.parse(pr.createdAt) >= Date.parse(t.createdAt);
}

async function adoptPrUrl(t) {
  const wt = await findWorktree(t.cwd, `kanban-${t.id.slice(0, 8)}`);
  const res = wt && wt.branch && await run(
    'gh',
    ['pr', 'list', '--head', wt.branch, '--state', 'all', '--limit', '1', '--json', 'url,createdAt'],
    t.cwd,
    30_000
  );
  let pr = null;
  if (res && res.ok && res.out) {
    try {
      pr = JSON.parse(res.out)[0] || null;
    } catch {}
  }
  if (!prBelongsTo(pr, t)) {
    t.prAdoptMisses = (t.prAdoptMisses || 0) + 1;
    touch(t); // save-only mutation — no type:'task' broadcast stamps this one
    if (t.prAdoptMisses === ADOPT_TRIES) {
      save();
      log(t, 'pr', `PR watch: no PR found for ${wt && wt.branch ? `branch ${wt.branch}` : 'this card'} — attach one by hand if it exists`);
    }
    return;
  }
  if (t.prUrl) return; // another writer recorded it while gh was running
  t.prUrl = pr.url;
  save();
  broadcast({ type: 'task', task: t });
  log(t, 'pr', `PR watch: adopted ${pr.url} — the card's PR URL was never recorded`);
}

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  let hot = false;
  try {
    await pool(state.tasks.filter(needsPrUrl), SWEEP_CONCURRENCY, adoptPrUrl);
    const watched = [...state.tasks].filter((t) => {
      if (!t.prUrl || t.prClosedNoted) return false;
      // Review cards are watched as usual; a done card whose PR never merged
      // still needs watching so an external merge releases its dependents.
      return t.status === 'review' || (t.status === 'done' && !t.prMergedAt);
    });
    // Fetch all PR states with bounded concurrency, then apply outcomes
    // serially so card mutations/manager invocations stay ordered.
    const infos = await pool(watched, SWEEP_CONCURRENCY, (t) => prInfo(t.prUrl));
    for (let i = 0; i < watched.length; i++) {
      const t = watched[i];
      const info = infos[i];
      if (!info) {
        t.prWatchFails = (t.prWatchFails || 0) + 1;
        touch(t); // save-only mutation — no type:'task' broadcast stamps this one
        if (t.prWatchFails === 3) {
          save();
          log(t, 'error', 'PR watch: gh has failed 3 sweeps in a row for this PR — merges and CI won\'t be detected until it recovers');
          errlog.capture('pr-flow', { taskId: t.id, taskTitle: t.title, text: 'PR watch cannot reach gh for this PR (missing/unauthed/rate-limited/deleted) — merges and CI updates are blind', detail: t.prUrl });
        }
        continue;
      }
      if (t.prWatchFails) {
        t.prWatchFails = 0;
        touch(t); // save-only mutation — no type:'task' broadcast stamps this one
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
          touch(t); // save-only mutation — no type:'task' broadcast stamps this one
          save();
          log(t, 'pr', 'PR watch: PR was closed without merging');
        }
      } else {
        const ready = trackChecks(t, info);
        const conflicting = info.mergeable === 'CONFLICTING';
        if (conflicting && autoFixEnabled()) {
          await maybeFix(t, info);
        }
        // Red checks on a clean, correctly-based PR: try the automatic CI fix
        // before involving the Sensei — its reject would burn a retry on a
        // fresh run where a session resume with the logs usually suffices.
        let fixing = false;
        const c = t.prChecks;
        if (ready && t.status === 'review' && !conflicting && !c.wrongBase && c.failing > 0 && autoFixEnabled()) {
          fixing = await maybeFixCi(t, c);
        }
        // Close the loop: the finish-time Sensei review ran before CI had
        // reported anything, so once the PR is decision-ready hand the card
        // back for the actual merge/reject verdict. Same gate as the finish
        // trigger. Never while a fixer is (about to be) running in the card's
        // worktree — a Sensei reject would launch a second agent into it.
        if (ready && t.status === 'review' && !fixing && !activeFixer(t.id)) {
          const manager = require('./manager');
          if (manager.config().triggers.onFinish) {
            manager.invoke(`PR checks settled for review card "${t.title}" (id ${t.id}) — give its merge/reject verdict`);
          }
        }
        // Checks still running (or GitHub still computing mergeability / the
        // no-CI grace window still open) on a review card: poll again in 60s
        // instead of waiting out the interval — this is what turns "merged ten
        // minutes after CI went green" into "merged a minute after". Bounded,
        // so one permanently-stuck required check can't poll gh forever.
        // trackChecks always stamps firstSeenAt; a missing one yields NaN here,
        // which fails the comparison and simply falls back to the interval.
        const watching = Date.now() - Date.parse(c.firstSeenAt);
        if (t.status === 'review' && watching < HOT_POLL_MAX_MS
            && (c.pending > 0 || info.mergeable === 'UNKNOWN' || (!c.noCi && !(c.passing + c.failing + c.pending > 0)))) {
          hot = true;
        }
      }
    }
  } finally {
    sweeping = false;
    clearTimeout(hotTimer);
    if (hot && watchMinutes() > 0) hotTimer = setTimeout(sweep, 60_000).unref();
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
      touch(t); // boot-time save-only mutation — keep v honest for persisted state
      changed = true;
    }
  }
  if (changed) save();
}

module.exports = { needsPrUrl, prBelongsTo, sweep, applyInterval, summarizeChecks, trackChecks, maybeFixCi, backfillMergedAt };
