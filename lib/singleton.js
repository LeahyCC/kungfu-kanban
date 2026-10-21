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

function readHolder() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // no lock file, or unreadable
  }
}

// Take the lock, or return the pid already holding it. Injectable liveness +
// sleep keep this testable without spawning real servers.
function claim(isLive = holderIsLive, sleep = sleepSync) {
  for (let i = 0; ; i++) {
    const prev = readHolder();
    if (!prev || prev === process.pid || !isLive(prev)) {
      if (prev === process.pid) return null;
      // Clear any stale file, then create with 'wx' so two servers starting
      // together cannot both write: the loser gets EEXIST and re-reads.
      try {
        fs.unlinkSync(LOCK);
      } catch {}
      try {
        fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
        return null;
      } catch (e) {
        if (e.code !== 'EEXIST') return null; // unwritable dir: don't block startup
        if (i >= RETRIES) return readHolder() || -1;
        continue;
      }
    }
    if (i >= RETRIES) return prev;
    sleep(RETRY_MS);
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
