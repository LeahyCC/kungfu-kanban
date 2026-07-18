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
  cache = { at: Date.now(), data: { version, head, behind, remoteVersion } };
  return cache.data;
}

// Fast-forward to origin/main; npm ci when the lockfile moved. The caller
// restarts the process afterwards (under launchd, exiting IS restarting).
function update() {
  return new Promise((resolve, reject) => {
    execFile('git', ['pull', '--ff-only'], { cwd: ROOT, timeout: 120_000 }, (err, stdout, stderr) => {
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
