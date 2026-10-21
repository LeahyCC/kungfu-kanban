// Post-merge cleanup: once a card's PR is MERGED, remove the worktree the board
// left behind plus its local and remote branch. Eleven worktrees piled up in
// one run, and a leftover dev server (Vite) inside one locked the folder so it
// could not be deleted. `gh pr merge --delete-branch` is not enough on its own:
// it skips the remote branch when the local checkout is detached.
//
// Every git/process call goes through `deps` so tests can stub them. Nothing
// here throws: each failure is returned in `problems` and the caller logs it.
const path = require('path');
const { execFile } = require('child_process');
const prflow = require('./prflow');

function defaultFindProcesses(dir) {
  return new Promise((resolve) => {
    const done = (err, stdout) => {
      // lsof exits 1 when nothing matches; treat any failure as "none found"
      // and let the worktree removal surface a real lock.
      const pids = String(stdout || '').split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
      resolve(err && !pids.length ? [] : pids);
    };
    if (process.platform === 'win32') {
      // The path travels in an env var, not the script text, so it is never
      // interpolated into a command line.
      const script = '$d=$env:KFK_WT;'
        + 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, KFK_WT: dir }, timeout: 30_000 }, done);
    } else {
      execFile('lsof', ['-t', '+D', dir], { timeout: 30_000, maxBuffer: 1024 * 1024 }, done);
    }
  });
}

function defaultKill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Returns { removed: string[], problems: string[], notes: string[] }.
async function cleanupMergedCard(task, baseBranch, deps = {}) {
  const run = deps.run || prflow.run;
  const findWorktree = deps.findWorktree || prflow.findWorktree;
  const findProcesses = deps.findProcesses || defaultFindProcesses;
  const kill = deps.kill || defaultKill;
  const selfPid = deps.selfPid || process.pid;
  const boardDir = deps.boardDir || process.cwd();
  const out = { removed: [], problems: [], notes: [] };
  try {
    const name = `kanban-${task.id.slice(0, 8)}`;
    const wt = await findWorktree(task.cwd, name);
    if (!wt || !wt.path) {
      out.notes.push(`no worktree matching "${name}" left to clean`);
      return out;
    }
    // Never remove the main checkout, or the folder the board itself runs from.
    if (path.resolve(wt.path) === path.resolve(task.cwd) || inside(boardDir, wt.path)) {
      out.problems.push(`refusing to remove ${wt.path}: it is the main checkout or the board's own folder`);
      return out;
    }
    const base = baseBranch || task.prBaseBranch || 'main';
    const branch = wt.branch;

    // Did the commits actually land? A squash or rebase merge rewrites them, so
    // the tip is not an ancestor even though GitHub says MERGED. In that case
    // trust GitHub but keep `-D` off the table: the local branch is the only
    // copy of the original commits.
    let landed = false;
    if (branch) {
      const fetch = await run('git', ['fetch', 'origin'], task.cwd);
      if (!fetch.ok) out.problems.push(`git fetch failed: ${fetch.err.slice(0, 200)}`);
      const tip = await run('git', ['rev-parse', branch], task.cwd);
      if (tip.ok && tip.out) {
        const anc = await run('git', ['merge-base', '--is-ancestor', tip.out, `origin/${base}`], task.cwd);
        landed = anc.ok;
      }
      if (!landed) out.notes.push(`${branch} tip is not an ancestor of origin/${base} (squash/rebase merge or stale fetch); trusting GitHub's MERGED state, keeping the local branch`);
    }

    for (const pid of new Set(await findProcesses(wt.path))) {
      if (pid === selfPid || pid === process.ppid) continue;
      if (kill(pid)) out.notes.push(`killed process ${pid} running in the worktree`);
      else out.problems.push(`could not kill process ${pid} running in the worktree`);
    }

    // claude --worktree creates card worktrees locked; a single --force
    // refuses those ("use 'remove -f -f' to override or unlock first").
    const rm = await run('git', ['worktree', 'remove', '--force', '--force', wt.path], task.cwd);
    if (rm.ok) out.removed.push(`worktree ${wt.path}`);
    else out.problems.push(`git worktree remove failed: ${rm.err.slice(0, 300)}`);

    if (branch) {
      if (landed && rm.ok) {
        const del = await run('git', ['branch', '-D', branch], task.cwd);
        if (del.ok) out.removed.push(`local branch ${branch}`);
        else out.problems.push(`git branch -D failed: ${del.err.slice(0, 300)}`);
      }
      const push = await run('git', ['push', 'origin', '--delete', branch], task.cwd);
      if (push.ok) out.removed.push(`remote branch ${branch}`);
      // GitHub auto-delete-on-merge may already have taken it
      else if (/remote ref does not exist|unable to delete/i.test(push.err)) out.notes.push(`remote branch ${branch} was already gone`);
      else out.problems.push(`git push origin --delete failed: ${push.err.slice(0, 300)}`);
    }
  } catch (e) {
    out.problems.push(`cleanup crashed: ${e && e.message ? e.message : e}`);
  }
  return out;
}

module.exports = { cleanupMergedCard, defaultFindProcesses };
