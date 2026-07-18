// Board update check + self-update, built on git so it works for any clone
// (and any fork — it compares against whatever `origin` is). The status line
// shows the local version; when the clone is behind origin/main it grows an
// update button that pulls fast-forward-only and restarts the server.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');

function git(args, timeout = 30_000) {
  return new Promise((resolve) =>
    execFile('git', args, { cwd: ROOT, timeout }, (err, stdout) => resolve(err ? null : stdout.trim()))
  );
}

function localVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

let cache = { at: 0, data: null };

// "1.2.3" > "1.2.2"? (plain numeric semver; anything unparsable loses)
function newer(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function check(force = false) {
  if (!force && cache.data && Date.now() - cache.at < 30 * 60_000) return cache.data;
  const version = localVersion();
  const head = await git(['rev-parse', '--short', 'HEAD']);
  await git(['fetch', '--quiet', 'origin', 'main'], 60_000); // offline → stale info, fine
  const behind = parseInt((await git(['rev-list', '--count', 'HEAD..origin/main'])) || '0', 10) || 0;
  let remoteVersion = null;
  if (behind > 0) {
    try {
      remoteVersion = JSON.parse(await git(['show', 'origin/main:package.json'])).version;
    } catch {}
  }
  // Being commits-behind isn't enough: a dev clone mid-release can trail
  // origin/main by a merge commit while already carrying a NEWER version —
  // offering "v0.3.2 available" on a v0.4.0 board is noise, not an update.
  const updateAvailable = behind > 0 && (remoteVersion ? newer(remoteVersion, version) : true);
  cache = { at: Date.now(), data: { version, head, behind, remoteVersion, updateAvailable } };
  return cache.data;
}

// Fast-forward to origin/main; npm ci when the lockfile moved. The caller
// restarts the process afterwards (under launchd, exiting IS restarting).
// Pull names origin + main explicitly: the current branch's upstream may be
// gone (e.g. a merged-and-deleted PR branch), which broke the bare `git pull`.
function update() {
  return new Promise((resolve, reject) => {
    execFile('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: ROOT, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 300)));
      cache = { at: 0, data: null };
      const finish = () => resolve({ output: stdout.trim().split('\n').pop() });
      if (/package-lock\.json/.test(stdout)) {
        execFile('npm', ['ci'], { cwd: ROOT, timeout: 300_000 }, (e) =>
          e ? reject(new Error('pulled, but npm ci failed — run it manually')) : finish());
      } else finish();
    });
  });
}

module.exports = { check, update };
