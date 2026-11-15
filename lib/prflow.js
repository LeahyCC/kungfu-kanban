// Repo → PR finishing flow: after a worktree task succeeds, commit anything
// the agent left uncommitted, push the worktree branch, and open a PR with
// the gh CLI (your existing gh auth — no PAT, no sandbox).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { state, getTask, save, appendTranscript, touch } = require('./store');
const { setStatus } = require('./transitions');
const errlog = require('./errlog');
const { broadcast } = require('./bus');
const pkg = require('../package.json');

// The footer credits the project so every PR on every install signposts the
// tool. homepage first, else repository.url stripped to a plain https link,
// else no link at all — forks keep working without a hardcoded URL.
function projectUrl() {
  if (pkg.homepage) return pkg.homepage;
  const repo = pkg.repository && (pkg.repository.url || pkg.repository);
  if (typeof repo === 'string') return repo.replace(/^git\+/, '').replace(/\.git$/, '');
  return null;
}

function footer() {
  const url = projectUrl();
  const name = url ? `[Kungfu Kanban](${url})` : 'Kungfu Kanban';
  const version = pkg.version ? ` v${pkg.version}` : '';
  return `🥋 Opened by ${name}${version}`;
}

// A repo's own contribution guide sometimes explicitly forbids crediting a
// tool/AI in commits or PRs (this project's own CLAUDE.md does) — honor that
// instead of stamping the footer on every PR regardless. Deliberately broad:
// a false positive just means a real PR loses a footer nobody will miss; a
// false negative leaves the (opt-out-able, see prFooterEnabled) status quo.
const NO_ATTRIBUTION_RE =
  /\b(no|never|forbids?|disallows?|do not)\b[^\n]{0,40}\b(ai|bot|tool|assistant|claude|copilot)\b[^\n]{0,40}\b(attribution|footer|fingerprints?|co-?authored)/i;

function contributingForbidsAttribution(cwd) {
  if (!cwd) return false;
  for (const name of ['CONTRIBUTING.md', 'CONTRIBUTING']) {
    let text;
    try {
      text = fs.readFileSync(path.join(cwd, name), 'utf8');
    } catch {
      continue;
    }
    if (NO_ATTRIBUTION_RE.test(text)) return true;
  }
  return false;
}

// The board-wide override — the blunt "at minimum" knob for anyone who wants
// the footer gone everywhere without relying on CONTRIBUTING.md detection.
function prFooterEnabled(cwd) {
  if (state.settings.prFooter === false) return false;
  return !contributingForbidsAttribution(cwd);
}

// A repo's own PR template — what a well-formed PR body should echo.
const TEMPLATE_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE/default.md',
  'PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
];

function readRepoPrTemplate(cwd) {
  if (!cwd) return null;
  for (const rel of TEMPLATE_PATHS) {
    try {
      return fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {}
  }
  return null;
}

function headingsOf(text) {
  return (text || '').split('\n')
    .map((l) => l.match(/^#{1,4}\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1].trim().toLowerCase());
}

// Does the run's final assistant message already read as a filled-in copy of
// the repo's own PR template? If a majority of the template's headings show
// up in the agent's own final report, that report IS the PR body — prefer it
// over the raw task prompt, which is instructions TO the agent, not a
// description of what it did.
function matchesTemplate(resultText, template) {
  const need = headingsOf(template);
  if (!need.length) return false;
  const have = new Set(headingsOf(resultText));
  return need.filter((h) => have.has(h)).length >= Math.ceil(need.length / 2);
}

// gh's dedupe message: `a pull request for branch "X" into branch "Y"
// already exists: <url>`. Pulled out so the parsing itself is unit-testable
// without mocking execFile/store for the whole PR-open flow.
function parseDuplicatePrUrl(err) {
  return (err.match(/already exists:\s*(https:\/\/\S+)/i) || [])[1] || null;
}

function run(cmd, args, cwd, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() });
    });
  });
}

// Indirection so tests can swap `run` on module.exports and drive the whole
// PR flow without a real gh or remote.
const sh = (...a) => module.exports.run(...a);

// What a failed git command actually said. git prints some failures on STDOUT
// ("nothing to commit, working tree clean"), and with stderr empty `err` falls
// back to execFile's "Command failed: <argv>", which only repeats the command.
// That is how a card's log ended up showing the commit line and no reason.
function failureText(res) {
  const out = (res.out || '').trim();
  const err = (res.err || '').trim();
  if (out && (!err || /^Command failed:/.test(err))) return out;
  return [err, out].filter(Boolean).join('\n');
}

// Branch NAMES are the agent's choice and can repeat across cards, so a PR on
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

// The open PR the card's agent already opened on this branch, or null. Agents
// often push and `gh pr create` themselves before the board's flow runs.
async function existingPr(task, branch, cwd) {
  const res = await sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'url,createdAt'], cwd, 30_000);
  if (!res.ok || !res.out) return null;
  let pr = null;
  try {
    pr = JSON.parse(res.out)[0] || null;
  } catch {}
  return prBelongsTo(pr, task) ? pr.url : null;
}

// Commit what the agent left in TRACKED files. Never untracked files: `git
// add -A` once shipped an auto-generated AGENTS.md in a PR. Never
// --no-verify: the repo's hooks are the repo's rules, so a hook that fails
// fails loudly and the work stays uncommitted in the worktree for a human.
// The caller carries on either way, because the agent's own commits still
// need pushing and a PR it opened still needs attaching.
async function commitLeftovers(task, wt, log) {
  const status = await sh('git', ['status', '--porcelain'], wt.path);
  if (!status.ok || !status.out) return;
  const lines = status.out.split('\n').filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
  const tracked = lines.filter((l) => !l.startsWith('??'));
  if (untracked.length) {
    const more = untracked.length > 5 ? ` (+${untracked.length - 5} more)` : '';
    log('pr', `PR flow: left ${untracked.length} untracked file(s) out of the commit: ${untracked.slice(0, 5).join(', ')}${more}`);
  }
  if (!tracked.length) return;
  const add = await sh('git', ['add', '-u'], wt.path);
  if (!add.ok) {
    log('error', `PR flow: git add -u failed, uncommitted changes left in the worktree: ${failureText(add).slice(0, 500)}`);
    return;
  }
  const commit = await sh('git', ['commit', '-m', task.title], wt.path);
  if (commit.ok) return log('pr', 'PR flow: committed uncommitted changes');
  const why = failureText(commit);
  if (/nothing to commit|nothing added to commit|no changes added to commit/i.test(why)) {
    log('pr', 'PR flow: nothing left to commit, the agent already committed its work');
    return;
  }
  log('error', `PR flow: commit failed, uncommitted changes left in the worktree (hooks were not skipped): ${why.slice(0, 500)}`);
}

// Find the worktree the CLI created for this task by asking git, so we don't
// depend on where `claude --worktree` chooses to put it.
async function findWorktree(repoCwd, name) {
  const res = await sh('git', ['worktree', 'list', '--porcelain'], repoCwd);
  if (!res.ok) return null;
  const entries = [];
  let cur = {};
  for (const line of res.out.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9) };
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === '' && cur.path) { entries.push(cur); cur = {}; }
  }
  if (cur.path) entries.push(cur);
  return entries.find((e) => (e.branch && e.branch.includes(name)) || e.path.includes(name)) || null;
}

// Runs the whole flow; appends progress to the task transcript and stores
// task.prUrl on success. Never throws — a failed PR flow leaves the card in
// review with the error visible in the transcript.
// committedOnly: for errored cards. Ship only what the agent already committed
// (or opened a PR for itself); never sweep half-finished uncommitted edits
// from a failed run into a new commit.
async function openPr(taskId, broadcast, { committedOnly = false } = {}) {
  const task = getTask(taskId);
  if (!task) return;
  const name = `kanban-${task.id.slice(0, 8)}`;
  const log = (kind, text) => {
    appendTranscript(task.id, { kind, text });
    broadcast({ type: 'output', taskId: task.id, entry: { kind, text } });
    // a failed commit/push/create means the work is stranded on the branch —
    // exactly the kind of operational stall the error tracker exists for
    if (kind === 'error') errlog.capture('pr-flow', { taskId: task.id, taskTitle: task.title, text });
  };

  const wt = await findWorktree(task.cwd, name);
  if (!wt || !wt.branch) {
    log('error', `PR flow: no worktree matching "${name}" found in ${task.cwd}, nothing to push`);
    return;
  }
  log('pr', `PR flow: worktree ${wt.path} (branch ${wt.branch})`);

  if (!committedOnly) await commitLeftovers(task, wt, log);

  // Pick a PR base that actually exists on the REMOTE. A card's explicit
  // base (prBaseBranch, e.g. "staging" for repos with a promotion flow whose
  // branch guards reject PRs straight into main) wins over the checkout's
  // current branch. Local remote-tracking refs can be stale (branch pushed
  // once, later deleted on GitHub), so ask origin itself via ls-remote; fall
  // back to gh's authoritative default.
  const cur = await sh('git', ['branch', '--show-current'], task.cwd);
  let baseBranch = task.prBaseBranch || (cur.ok && cur.out ? cur.out : null);
  const remoteHas = baseBranch
    ? await sh('git', ['ls-remote', '--heads', 'origin', baseBranch], task.cwd, 30_000)
    : { ok: false, out: '' };
  if (!remoteHas.ok || !remoteHas.out) {
    const def = await sh('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], task.cwd, 30_000);
    if (def.ok && def.out) baseBranch = def.out;
    else {
      const head = await sh('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], task.cwd);
      baseBranch = head.ok && head.out ? head.out.replace('refs/remotes/origin/', '') : 'main';
    }
    log('pr', `PR flow: checkout branch isn't on the remote, basing the PR on ${baseBranch}`);
  }

  // Anything to ship?
  const ahead = await sh('git', ['rev-list', '--count', `origin/${baseBranch}..HEAD`], wt.path);
  if (ahead.ok && ahead.out === '0') {
    log('pr', 'PR flow: branch has no commits beyond base, skipping PR');
    return;
  }

  // No --no-verify here either: a pre-push hook that fails is reported. The
  // flow still looks for a PR the agent pushed and opened itself.
  const push = await sh('git', ['push', '-u', 'origin', wt.branch], wt.path, 120_000);
  if (!push.ok) {
    log('error', `PR flow: push failed: ${failureText(push).slice(0, 500)}`);
    if (task.prUrl) return task.prUrl;
    const mine = await existingPr(task, wt.branch, wt.path);
    if (mine) return recordPr(task, mine, `PR flow: the agent's own PR is on the branch, recorded ${mine}`, log, broadcast);
    return;
  }
  log('pr', `PR flow: pushed ${wt.branch}`);

  // New commits invalidate the stored rollup: CI is about to re-run against
  // the new head. Leaving the old one would let a reviewer merge on green
  // checks that never saw this code (or reject on failures already fixed).
  // Dropping it reads as "no checks reported yet" — the watcher re-polls and
  // the Sensei's own rule holds the card until real results land.
  // New code also earns a fresh auto-fix budget: tying the reset to the push
  // rather than to checks going green means a flapping check can't hand out
  // unlimited fix attempts on the same commit.
  if (task.prChecks) {
    delete task.prChecks;
    task.ciFixes = 0;
    delete task.ciFixGaveUp;
    touch(task); // save-only mutation — no type:'task' broadcast stamps this one
    save();
    log('pr', 'PR flow: new commits pushed, CI results reset, waiting for the re-run');
  }

  // Follow-up runs on a card that already has a PR: the push above updated it.
  if (task.prUrl) {
    errlog.resolveTask(task.id, ['pr-flow']); // the flow just worked end-to-end
    log('pr', `PR flow: updated existing PR ${task.prUrl}`);
    return task.prUrl;
  }

  // The agent may have opened the PR itself. Attach it instead of asking gh
  // to create a duplicate.
  const mine = await existingPr(task, wt.branch, wt.path);
  if (mine) return recordPr(task, mine, `PR flow: the agent already opened ${mine}, recorded it`, log, broadcast);

  const body = prBody(task);
  const createWith = (base) =>
    sh('gh', ['pr', 'create', '--head', wt.branch, '--base', base, '--title', task.title.slice(0, 200), '--body', body], wt.path, 120_000);
  let pr = await createWith(baseBranch);
  if (!pr.ok && /base ref must be a branch/i.test(pr.err)) {
    // the chosen base still doesn't exist on GitHub — final net: gh's default
    const def = await sh('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], task.cwd, 30_000);
    if (def.ok && def.out && def.out !== baseBranch) {
      log('pr', `PR flow: base ${baseBranch} rejected by GitHub, retrying against ${def.out}`);
      baseBranch = def.out;
      pr = await createWith(baseBranch);
    }
  }
  if (!pr.ok && /sha can't be blank|could not resolve|not found/i.test(pr.err)) {
    // gh raced GitHub's indexing of the just-pushed branch — give it a beat
    await new Promise((r) => setTimeout(r, 4000));
    pr = await createWith(baseBranch);
  }
  if (!pr.ok) {
    // gh's own PR-flow watcher already opened this PR (race with the card's
    // agent) — gh refuses to create a duplicate but hands back the existing
    // URL in the same breath. Treat that as success instead of a stranded
    // error: the PR is really there, just not recorded on the task yet.
    const dupUrl = parseDuplicatePrUrl(pr.err);
    if (dupUrl) return recordPr(task, dupUrl, `PR flow: PR already existed, recorded ${dupUrl}`, log, broadcast);
    return log('error', `PR flow: gh pr create failed: ${failureText(pr).slice(0, 500)}`);
  }

  const url = (pr.out.match(/https:\/\/\S+/) || [])[0];
  if (!url) return log('error', `PR flow: gh returned no PR URL: ${pr.out.slice(0, 300)}`);
  return recordPr(task, url, `PR flow: opened ${url}`, log, broadcast);
}

function recordPr(task, url, note, log, broadcast) {
  task.prUrl = url;
  errlog.resolveTask(task.id, ['pr-flow']);
  save();
  log('pr', note);
  broadcast({ type: 'task', task });
  return url;
}

// Merge an open PR and finish the card — shared by the human "merge" button
// (server.js) and the Sensei's merge_pr action (lib/manager.js): status done,
// verdict stamp, prMergedAt, transcript note, notify, pumpQueue.
function mergePr(task, verdict = 'PR merged') {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'merge', task.prUrl, '--merge'], { timeout: 60_000, cwd: task.cwd }, (err, stdout, stderr) => {
      const note = (kind, text) => {
        appendTranscript(task.id, { kind, text });
        broadcast({ type: 'output', taskId: task.id, entry: { kind, text } });
      };
      if (err) {
        const msg = (stderr || err.message || '').trim().slice(0, 300);
        note('error', `PR merge failed: ${msg}`);
        resolve({ ok: false, error: msg });
        return;
      }
      setStatus(task, 'done', { merged: true }); // the merge moved it, nobody approved it
      task.managerVerdict = verdict;
      task.prMergedAt = new Date().toISOString();
      note('pr', 'PR merged from the board');
      require('./notify').notify('Kungfu Kanban — PR merged', task.title, task.prUrl);
      save();
      broadcast({ type: 'task', task });
      require('./runner').pumpQueue(); // the merge may free dependent cards
      resolve({ ok: true });
    });
  });
}

// Acceptance criteria as a GitHub task list, one "- [ ]" per line. Existing
// bullets, numbers and boxes are stripped first so they are not doubled.
function acceptanceChecklist(text) {
  const items = String(text || '').split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/, '').trim())
    .filter(Boolean);
  if (!items.length) return '';
  return `## Acceptance criteria\n${items.map((i) => `- [ ] ${i}`).join('\n')}`.slice(0, 1500);
}

// Colin's rule for anything going out under his name: no em dashes. The
// agent's own summary may still carry them, so they are swapped for commas.
function noEmDashes(text) {
  return text.replace(/\s*\u2014\s*/g, ', ');
}

// PR body for a new PR: short on purpose. The card prompt is instructions TO
// the agent and used to be pasted in whole; reviewers want what was done and
// what to check. So: the run's final report (or, when it fills in the repo's
// PR template, that report as written), then the acceptance checklist.
// "Fixes #N" is a GitHub closing keyword: merging the PR auto-closes the
// imported source issue.
function prBody(task) {
  const result = (task.resultText || '').trim();
  const template = readRepoPrTemplate(task.cwd);
  // A report that already opens with its own heading keeps it.
  const summary = template && matchesTemplate(result, template)
    ? result.slice(0, 4000)
    : result ? `${/^#/.test(result) ? '' : '## Summary\n'}${result.slice(0, 2000)}` : '';
  return noEmDashes([
    task.issueNumber ? `Fixes #${task.issueNumber}` : '',
    summary,
    acceptanceChecklist(task.acceptanceCriteria),
    task.skills && task.skills.length
      ? `Skills: ${task.skills.map((s) => `\`${s}\``).join(', ')}${task.skillsAuto ? ' (auto-selected)' : ''}`
      : '',
    prFooterEnabled(task.cwd) ? footer() : '',
  ].filter(Boolean).join('\n\n'));
}

module.exports = {
  openPr, findWorktree, run, mergePr, prBody, parseDuplicatePrUrl, failureText, prBelongsTo,
  existingPr, acceptanceChecklist,
  contributingForbidsAttribution, prFooterEnabled, matchesTemplate, headingsOf,
};
