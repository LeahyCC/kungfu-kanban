// The board stopped twice on Windows with no clean shutdown: once with "^C" as
// the last log line, once with nothing at all, and every card agent died with
// it. These drive the real server: every exit now logs its reason, SIGHUP is a
// clean shutdown, and the Windows supervisor restarts a dead server and stops
// it cleanly over IPC.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUPERVISE = path.join(ROOT, 'scripts', 'windows', 'supervise.js');

function env(dataDir, port) {
  return { ...process.env, KFK_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', KFK_TEST: '1' };
}

async function waitFor(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const up = (port) => fetch(`http://127.0.0.1:${port}/api/config`).then((r) => r.ok);
const port = () => 20000 + Math.floor(Math.random() * 30000);

test('SIGHUP (a closed console window on Windows) shuts down cleanly and logs why', { skip: process.platform === 'win32' && 'Windows cannot deliver SIGHUP to another process' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-hup-'));
  const p = port();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: env(dataDir, p), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  assert.ok(await waitFor(() => up(p)), 'server came up');
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  child.kill('SIGHUP');
  assert.equal(await exited, 0);
  assert.match(err, /board exit: SIGHUP \(code 0\)/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('--install writes the Startup script and keeps a different old one as .bak', () => {
  const { execFileSync } = require('child_process');
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-appdata-'));
  const startup = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  fs.mkdirSync(startup, { recursive: true });
  const file = path.join(startup, 'kungfu-kanban.cmd');
  fs.writeFileSync(file, 'start "kungfu-kanban" /min cmd /c "node server.js"');
  execFileSync(process.execPath, [SUPERVISE, '--install'], { env: { ...process.env, APPDATA: appdata } });
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /scripts\\windows\\supervise\.js/);
  assert.ok(body.includes(`cd /d "${path.resolve(ROOT)}"`));
  assert.ok(!/start .*\/min cmd/.test(body), 'no closable console window');
  assert.match(fs.readFileSync(`${file}.bak`, 'utf8'), /\/min cmd/);
  fs.rmSync(appdata, { recursive: true, force: true });
});

test('supervisor restarts a killed server and stops it cleanly over IPC', { timeout: 90_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-sup-'));
  const log = path.join(dataDir, 'server.log');
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const p = port();
  const sup = spawn(process.execPath, [SUPERVISE, '--run'], { cwd: ROOT, env: env(dataDir, p), stdio: 'ignore' });
  const supExit = new Promise((r) => sup.once('exit', (code) => r(code)));
  try {
    assert.ok(await waitFor(() => up(p)), 'server came up under the supervisor');
    const first = parseInt((read().match(/started server\.js \(pid (\d+)\)/) || [])[1], 10);
    assert.ok(first > 0);

    process.kill(first, 'SIGKILL'); // a hard kill, like Task Manager
    assert.ok(await waitFor(() => (read().match(/started server\.js/g) || []).length === 2), 'supervisor started a second server');
    assert.ok(await waitFor(() => up(p)), 'and it answers');

    fs.writeFileSync(path.join(dataDir, 'supervisor.stop'), 'now');
    assert.equal(await supExit, 0);
    const text = read();
    assert.match(text, /board exit: supervisor: stop requested \(code 0\)/, 'the server shut down through its own handler');
    assert.match(text, /supervisor: stopped/);
    assert.ok(!fs.existsSync(path.join(dataDir, 'supervisor.pid')));
  } finally {
    if (sup.exitCode === null) sup.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
