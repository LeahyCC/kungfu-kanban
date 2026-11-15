// Post-merge cleanup: once a card's PR is MERGED, remove the worktree the board
// left behind plus its local and remote branch. Eleven worktrees piled up in
// one run, and a leftover dev server (Vite) inside one locked the folder so it
// could not be deleted. `gh pr merge --delete-branch` is not enough on its own:
// it skips the remote branch when the local checkout is detached.
//
// Also the end-of-run reap (reapRun): a card's agent that starts `next dev` and
// never stops it holds the worktree and a port until the merge, and outlives
// a board crash.
//
// Every git/process/fs call goes through `deps` so tests can stub them. Nothing
// here throws: each failure is returned in `problems` and the caller logs it.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const prflow = require('./prflow');

// Returns [{ pid, name }]. git prints worktree paths with forward slashes, but
// Windows command lines carry backslashes, so both spellings are searched there.
function defaultFindProcesses(dir) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // The paths travel in env vars, not the script text, so they are never
      // interpolated into a command line.
      const script = '$a=$env:KFK_WT;$b=$env:KFK_WT2;'
        + 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.IndexOf($a,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf($b,[StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { "$($_.ProcessId)`t$($_.Name)" }';
      const env = { ...process.env, KFK_WT: dir.replace(/\//g, '\\'), KFK_WT2: dir.replace(/\\/g, '/') };
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env, timeout: 30_000, windowsHide: true }, (err, stdout) => resolve(parseTabbed(stdout)));
    } else {
      // lsof exits 1 when nothing matches; treat any failure as "none found"
      // and let the worktree removal surface a real lock.
      execFile('lsof', ['-F', 'pc', '+D', dir], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(parseLsof(stdout)));
    }
  });
}

function parseTabbed(stdout) {
  return String(stdout || '').split(/\r?\n/).map((l) => {
    const [pid, name] = l.trim().split('\t');
    return { pid: parseInt(pid, 10), name: name || '' };
  }).filter((p) => p.pid > 0);
}

// lsof -F pc: a "p<pid>" line, then a "c<command>" line, per process.
function parseLsof(stdout) {
  const out = [];
  for (const l of String(stdout || '').split('\n')) {
    if (l.startsWith('p')) out.push({ pid: parseInt(l.slice(1), 10), name: '' });
    else if (l.startsWith('c') && out.length) out[out.length - 1].name = l.slice(1);
  }
  return out.filter((p) => p.pid > 0);
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

// Never touch the main checkout, or the folder the board itself runs from.
function unsafeTarget(task, wtPath, boardDir) {
  return path.resolve(wtPath) === path.resolve(task.cwd) || inside(boardDir, wtPath);
}

// Kill every process running inside wtPath except the board and its parent.
// Older stubs return bare pids, so both shapes are accepted.
async function killIn(wtPath, deps, out) {
  const findProcesses = deps.findProcesses || defaultFindProcesses;
  const kill = deps.kill || defaultKill;
  const selfPid = deps.selfPid || process.pid;
  const seen = new Set();
  for (const p of await findProcesses(wtPath)) {
    const { pid, name } = typeof p === 'number' ? { pid: p, name: '' } : p;
    if (seen.has(pid) || pid === selfPid || pid === process.ppid) continue;
    seen.add(pid);
    const label = name ? `${pid} (${name})` : String(pid);
    if (kill(pid)) out.notes.push(`killed process ${label} running in the worktree`);
    else out.problems.push(`could not kill process ${label} running in the worktree`);
  }
}

// On Windows `git worktree remove` can succeed and still leave the folder,
// full of pnpm's node_modules and .next, when a file was briefly locked. No
// .git entry inside means git no longer owns it, so it is safe to delete.
// fs.rmSync retries EBUSY/EPERM/ENOTEMPTY by itself.
function removeLeftover(wtPath, deps, out) {
  const exists = deps.exists || fs.existsSync;
  const rm = deps.rm || ((p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
  if (!exists(wtPath)) return;
  if (exists(path.join(wtPath, '.git'))) {
    out.problems.push(`${wtPath} still holds a .git entry after git worktree remove, left it alone`);
    return;
  }
  try {
    rm(wtPath);
  } catch (e) {
    out.problems.push(`leftover folder ${wtPath} could not be deleted: ${e && e.message ? e.message : e}`);
    return;
  }
  if (exists(wtPath)) out.problems.push(`leftover folder ${wtPath} is still there after deleting it`);
  else out.removed.push(`leftover folder ${wtPath}`);
}

// Returns { removed: string[], problems: string[], notes: string[] }.
async function cleanupMergedCard(task, baseBranch, deps = {}) {
  const run = deps.run || prflow.run;
  const findWorktree = deps.findWorktree || prflow.findWorktree;
  const boardDir = deps.boardDir || process.cwd();
  const out = { removed: [], problems: [], notes: [] };
  try {
    const name = `kanban-${task.id.slice(0, 8)}`;
    const wt = await findWorktree(task.cwd, name);
    if (!wt || !wt.path) {
      out.notes.push(`no worktree matching "${name}" left to clean`);
      return out;
    }
    if (unsafeTarget(task, wt.path, boardDir)) {
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

    await killIn(wt.path, deps, out);

    // claude --worktree creates card worktrees locked; a single --force
    // refuses those ("use 'remove -f -f' to override or unlock first").
    const rm = await run('git', ['worktree', 'remove', '--force', '--force', wt.path], task.cwd);
    if (rm.ok) {
      out.removed.push(`worktree ${wt.path}`);
      removeLeftover(wt.path, deps, out);
    } else out.problems.push(`git worktree remove failed: ${rm.err.slice(0, 300)}`);

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

    // `claude --worktree kanban-<id>` creates branch worktree-kanban-<id>, and
    // the agent then switches to its own feature branch, so the branch above
    // is not the one the worktree started on. That original branch was left
    // behind after every merge. It only goes when it holds nothing beyond the
    // base: a commit on it is work nobody shipped.
    const original = `worktree-${name}`;
    if (rm.ok && original !== branch) {
      const has = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${original}`], task.cwd);
      if (has.ok && has.out) {
        const ahead = await run('git', ['rev-list', '--count', `origin/${base}..refs/heads/${original}`], task.cwd);
        if (ahead.ok && ahead.out === '0') {
          const del = await run('git', ['branch', '-D', original], task.cwd);
          if (del.ok) out.removed.push(`local branch ${original}`);
          else out.problems.push(`git branch -D ${original} failed: ${del.err.slice(0, 300)}`);
        } else if (ahead.ok) {
          out.notes.push(`kept ${original}: it has ${ahead.out} commit(s) beyond origin/${base}`);
        } else {
          out.notes.push(`kept ${original}: could not compare it with origin/${base}`);
        }
      }
    }
  } catch (e) {
    out.problems.push(`cleanup crashed: ${e && e.message ? e.message : e}`);
  }
  return out;
}

// End of a card run (done, failed, stopped, or interrupted by a restart): stop
// whatever the agent left running inside the card's worktree, such as a dev
// server holding the folder and a port. Worktree cards only; a non-worktree
// card runs in the user's own checkout, where their own processes live.
// `terminals` is the board's open terminal sessions: a person working in the
// worktree from the board's terminal keeps their shell and what it started.
// Returns { removed, problems, notes } like cleanupMergedCard.
async function reapRun(task, deps = {}) {
  const findWorktree = deps.findWorktree || prflow.findWorktree;
  const boardDir = deps.boardDir || process.cwd();
  const terminals = deps.terminals || [];
  const out = { removed: [], problems: [], notes: [] };
  if (!task || !task.worktree || !task.cwd) return out;
  try {
    const wt = await findWorktree(task.cwd, `kanban-${task.id.slice(0, 8)}`);
    if (!wt || !wt.path || unsafeTarget(task, wt.path, boardDir)) return out;
    if (terminals.some((s) => s && s.cwd && !s.exited && inside(s.cwd, wt.path))) {
      out.notes.push('a board terminal is open in the worktree, so its processes were left running');
      return out;
    }
    await killIn(wt.path, deps, out);
  } catch (e) {
    out.problems.push(`process reap crashed: ${e && e.message ? e.message : e}`);
  }
  return out;
}

module.exports = { cleanupMergedCard, reapRun, defaultFindProcesses, parseLsof, parseTabbed };
