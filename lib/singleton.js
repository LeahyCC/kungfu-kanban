// One automation loop per data dir.
//
// The port is not a lock: a scratch server picks its own, and a second
// `node server.js` from the repo happily runs the Sensei interval, the PR
// watcher, and the inbox watcher against the SAME data/ as the live board.
// One did. A card's smoke test on 2026-07-22 backgrounded a stray
// `node -e "require('./server.js')"` in the checkout and left it running for
// six days: a Sensei run every five minutes whose CLI could not authenticate
// (1331 "Not logged in" rows in the real error tracker), a second watcher
// racing the inbox (duplicate imports, "could not archive" errors), and a
// duplicate card launched and failed. None of it was visible as a second
// server — it never held :4747.
//
// So the data dir is the lock.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DATA_DIR } = require('./store');

const LOCK = path.join(DATA_DIR, 'server.lock');
const RETRY_MS = 500;
const RETRIES = 6; // ~3s — covers launchd kickstart -k, where the old process is still exiting

// A live pid is not proof on its own: pids get reused, and a false positive
// here keeps the real board down. Require the process to actually be a server.
function holderIsLive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
  } catch {
    return false;
  }
  try {
    return /server\.js/.test(commandLine(pid));
  } catch {
    // There is no `ps` on Windows, so this used to return false for every live
    // pid and a second server walked straight past the lock. On Windows an
    // unreadable command line means "assume it is a server": a stranded board
    // is fixed by deleting server.lock, two writers on one data dir is not.
    return process.platform === 'win32';
  }
}

function commandLine(pid) {
  if (process.platform !== 'win32') {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  }
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
}

function parsePid(text) {
  const pid = parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readHolder(fsx = fs) {
  try {
    return parsePid(fsx.readFileSync(LOCK, 'utf8'));
  } catch {
    return null; // no lock file, or unreadable
  }
}

let staleSeq = 0;

// Take the lock, or return the pid already holding it. Injectable liveness,
// sleep, fs and pid keep this testable without spawning real servers.
//
// Clearing a stale lock must not be unlink-then-create: two starters can both
// see the same stale file, one creates a fresh lock, and the other's unlink
// deletes it, so both win. Instead the stale file is renamed away. Only one
// rename of a given file can succeed, and 'wx' create then decides the rest.
function claim(isLive = holderIsLive, sleep = sleepSync, fsx = fs, pid = process.pid) {
  // Out of retries gives up with the holder; otherwise waits and goes round again.
  const backoff = (i, holder, wait) => {
    if (i >= RETRIES) return { done: holder };
    if (wait) sleep(RETRY_MS);
    return null;
  };
  for (let i = 0; ; i++) {
    let text = null; // null = no lock file at all
    try {
      text = fsx.readFileSync(LOCK, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') text = ''; // unreadable: treat like junk, the checks below decide
    }
    const prev = text === null ? null : parsePid(text);
    if (prev === pid) return null;
    if (prev && isLive(prev)) {
      const r = backoff(i, prev, true);
      if (r) return r.done;
      continue;
    }

    if (text !== null) {
      // Stale or junk lock. Rename it to a name only we use, so we can only ever
      // remove the file we looked at.
      const moved = `${LOCK}.stale.${pid}.${staleSeq++}`;
      try {
        fsx.renameSync(LOCK, moved);
      } catch (e) {
        if (e.code === 'ENOENT') {
          // Someone else cleared it first. Re-read.
          const r = backoff(i, readHolder(fsx) || -1, false);
          if (r) return r.done;
          continue;
        }
        return null; // unwritable dir: don't block startup
      }
      let movedText = null;
      try {
        movedText = fsx.readFileSync(moved, 'utf8');
      } catch {}
      const movedPid = movedText === null ? null : parsePid(movedText);
      if (movedText !== text && movedPid && movedPid !== pid && isLive(movedPid)) {
        // Between our read and our rename another server replaced the stale file
        // with its own live lock, and we just moved that. Put it back; link fails
        // rather than overwrite if the path was taken in the meantime.
        try {
          fsx.linkSync(moved, LOCK);
        } catch {}
        try {
          fsx.unlinkSync(moved);
        } catch {}
        const r = backoff(i, movedPid, false);
        if (r) return r.done;
        continue;
      }
      try {
        fsx.unlinkSync(moved);
      } catch {}
    }

    try {
      fsx.writeFileSync(LOCK, String(pid), { flag: 'wx' });
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') return null; // unwritable dir: don't block startup
      const r = backoff(i, readHolder(fsx) || -1, false);
      if (r) return r.done;
    }
  }
}

function release() {
  if (readHolder() === process.pid) {
    try {
      fs.unlinkSync(LOCK);
    } catch {}
  }
}

// Block without a subprocess or an async hop — this runs before the server has
// armed anything, and the whole point is to decide before that happens.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = { claim, release, holderIsLive, readHolder, LOCK };
