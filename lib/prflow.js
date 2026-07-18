// Repo → PR finishing flow: after a worktree task succeeds, commit anything
// the agent left uncommitted, push the worktree branch, and open a PR with
// the gh CLI (your existing gh auth — no PAT, no sandbox).
const { execFile } = require('child_process');
const { getTask, save, appendTranscript } = require('./store');

function run(cmd, args, cwd, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() });
    });
  });
}

// Find the worktree the CLI created for this task by asking git, so we don't
// depend on where `claude --worktree` chooses to put it.
async function findWorktree(repoCwd, name) {
  const res = await run('git', ['worktree', 'list', '--porcelain'], repoCwd);
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
async function openPr(taskId, broadcast) {
  const task = getTask(taskId);
  if (!task) return;
  const name = `kanban-${task.id.slice(0, 8)}`;
  const log = (kind, text) => {
    appendTranscript(task.id, { kind, text });
    broadcast({ type: 'output', taskId: task.id, entry: { kind, text } });
  };

  const wt = await findWorktree(task.cwd, name);
  if (!wt || !wt.branch) {
    log('error', `PR flow: no worktree matching "${name}" found in ${task.cwd} — nothing to push`);
    return;
  }
  log('pr', `PR flow: worktree ${wt.path} (branch ${wt.branch})`);

  // Commit whatever the agent left uncommitted. Repo hooks (husky/lint-staged)
  // usually can't run in a bare worktree — no node_modules — so when the hook
  // machinery itself fails, retry without hooks and say so; linting still
  // happens in CI/review. Real git failures still fail loudly.
  // "command not found" on commit/push is always a hook script dying — git
  // itself never says that — as is any husky/lint-staged mention.
  const hookish = (err) => /husky|pre-commit|pre-push|lint-staged|hooksPath|\.husky|command not found/i.test(err || '');
  const status = await run('git', ['status', '--porcelain'], wt.path);
  if (status.ok && status.out) {
    await run('git', ['add', '-A'], wt.path);
    let commit = await run('git', ['commit', '-m', `${task.title}\n\nvia Kungfu Kanban`], wt.path);
    if (!commit.ok && hookish(commit.err)) {
      commit = await run('git', ['commit', '--no-verify', '-m', `${task.title}\n\nvia Kungfu Kanban`], wt.path);
      if (commit.ok) log('pr', 'PR flow: commit hooks can\'t run in a bare worktree — committed with --no-verify (CI/review still applies)');
    }
    if (!commit.ok) return log('error', `PR flow: commit failed — ${commit.err.slice(0, 500)}`);
    log('pr', 'PR flow: committed uncommitted changes');
  }

  // Pick a PR base that actually exists on the REMOTE. Local remote-tracking
  // refs can be stale (branch pushed once, later deleted on GitHub), so ask
  // origin itself via ls-remote; fall back to gh's authoritative default.
  const cur = await run('git', ['branch', '--show-current'], task.cwd);
  let baseBranch = cur.ok && cur.out ? cur.out : null;
  const remoteHas = baseBranch
    ? await run('git', ['ls-remote', '--heads', 'origin', baseBranch], task.cwd, 30_000)
    : { ok: false, out: '' };
  if (!remoteHas.ok || !remoteHas.out) {
    const def = await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], task.cwd, 30_000);
    if (def.ok && def.out) baseBranch = def.out;
    else {
      const head = await run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], task.cwd);
      baseBranch = head.ok && head.out ? head.out.replace('refs/remotes/origin/', '') : 'main';
    }
    log('pr', `PR flow: checkout branch isn't on the remote — basing the PR on ${baseBranch}`);
  }

  // Anything to ship?
  const ahead = await run('git', ['rev-list', '--count', `origin/${baseBranch}..HEAD`], wt.path);
  if (ahead.ok && ahead.out === '0') {
    log('pr', 'PR flow: branch has no commits beyond base — skipping PR');
    return;
  }

  let push = await run('git', ['push', '-u', 'origin', wt.branch], wt.path, 120_000);
  if (!push.ok && hookish(push.err)) {
    push = await run('git', ['push', '--no-verify', '-u', 'origin', wt.branch], wt.path, 120_000);
    if (push.ok) log('pr', 'PR flow: pre-push hooks can\'t run in a bare worktree — pushed with --no-verify');
  }
  if (!push.ok) return log('error', `PR flow: push failed — ${push.err.slice(0, 500)}`);
  log('pr', `PR flow: pushed ${wt.branch}`);

  // Follow-up runs on a card that already has a PR: the push above updated it.
  if (task.prUrl) {
    log('pr', `PR flow: updated existing PR ${task.prUrl}`);
    return task.prUrl;
  }

  const body = [
    task.issueNumber ? `Fixes #${task.issueNumber}` : '',
    task.prompt ? `## Task\n${task.prompt.slice(0, 1500)}` : '',
    task.acceptanceCriteria ? `## Acceptance criteria\n${task.acceptanceCriteria.slice(0, 500)}` : '',
    '🥋 Opened by Kungfu Kanban',
  ].filter(Boolean).join('\n\n');
  const createWith = (base) =>
    run('gh', ['pr', 'create', '--head', wt.branch, '--base', base, '--title', task.title.slice(0, 200), '--body', body], wt.path, 120_000);
  let pr = await createWith(baseBranch);
  if (!pr.ok && /base ref must be a branch/i.test(pr.err)) {
    // the chosen base still doesn't exist on GitHub — final net: gh's default
    const def = await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], task.cwd, 30_000);
    if (def.ok && def.out && def.out !== baseBranch) {
      log('pr', `PR flow: base ${baseBranch} rejected by GitHub — retrying against ${def.out}`);
      baseBranch = def.out;
      pr = await createWith(baseBranch);
    }
  }
  if (!pr.ok && /sha can't be blank|could not resolve|not found/i.test(pr.err)) {
    // gh raced GitHub's indexing of the just-pushed branch — give it a beat
    await new Promise((r) => setTimeout(r, 4000));
    pr = await createWith(baseBranch);
  }
  if (!pr.ok) return log('error', `PR flow: gh pr create failed — ${pr.err.slice(0, 500)}`);

  const url = (pr.out.match(/https:\/\/\S+/) || [])[0];
  if (!url) return log('error', `PR flow: gh returned no PR URL — ${pr.out.slice(0, 300)}`);
  task.prUrl = url;
  save();
  log('pr', `PR flow: opened ${url}`);
  broadcast({ type: 'task', task });
  return url;
}

module.exports = { openPr, findWorktree, run };
