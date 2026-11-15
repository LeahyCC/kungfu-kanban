'use strict';
// Runs the board on Windows the way launchd runs it on the Mac: no console
// window anyone can close, and a restart whenever server.js exits.
//
// Why: the board used to start from the Startup folder as
// `start /min cmd /c "node server.js >> data\server.log"`. Closing that
// minimised window (or Ctrl+C in it) ended the board and every card agent with
// it, and once left no log line at all.
//
//   node scripts\windows\supervise.js          start (returns at once)
//   node scripts\windows\supervise.js --stop   stop the board cleanly
//   node scripts\windows\supervise.js --status say whether it is running
//   node scripts\windows\supervise.js --install put the logon script in Startup
//
// Start relaunches this file detached (no console of its own) with --run. That
// copy spawns server.js with windowsHide, which gives the server a console
// with no window: git, gh and claude inherit it, so nothing flashes on screen.
// Output goes to data\server.log, as before.
//
// Stop writes data\supervisor.stop. The supervisor sees it, asks the server to
// shut down over IPC (Windows has no SIGTERM to send; process.kill is a hard
// kill), waits for it to exit, and does not restart it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = process.env.KFK_DATA_DIR || path.join(ROOT, 'data');
const LOG = path.join(DATA, 'server.log');
const PIDFILE = path.join(DATA, 'supervisor.pid');
const STOPFILE = path.join(DATA, 'supervisor.stop');

const RESTART_MS = 2_000;
const BURST = 5; // this many exits inside BURST_WINDOW_MS ...
const BURST_WINDOW_MS = 120_000;
const BACKOFF_MS = 60_000; // ... and it waits this long before trying again
const STOP_GRACE_MS = 20_000;

function stamp(msg) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} supervisor: ${msg}\n`);
  } catch {}
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPid() {
  try {
    const pid = parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10);
    return pid > 0 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function start() {
  const pid = runningPid();
  if (pid) {
    console.log(`already running (supervisor pid ${pid})`);
    return;
  }
  try {
    fs.unlinkSync(STOPFILE);
  } catch {}
  fs.mkdirSync(DATA, { recursive: true });
  const child = spawn(process.execPath, [__filename, '--run'], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  console.log(`started (supervisor pid ${child.pid}); log: ${LOG}`);
}

function stop() {
  const pid = runningPid();
  if (!pid) {
    console.log('not running');
    return;
  }
  fs.writeFileSync(STOPFILE, new Date().toISOString());
  console.log(`asked supervisor ${pid} to stop the board`);
}

function supervise() {
  fs.writeFileSync(PIDFILE, String(process.pid));
  let server = null;
  let stopping = false;
  const exits = [];

  const launch = () => {
    if (stopping) return;
    const fd = fs.openSync(LOG, 'a');
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', fd, fd, 'ipc'],
      env: process.env,
    });
    fs.closeSync(fd); // the child holds its own copy
    stamp(`started server.js (pid ${server.pid})`);
    server.on('exit', (code, signal) => {
      server = null;
      stamp(`server.js exited (code ${code}${signal ? `, signal ${signal}` : ''})`);
      if (stopping) return finish();
      const now = Date.now();
      exits.push(now);
      while (exits.length && now - exits[0] > BURST_WINDOW_MS) exits.shift();
      const wait = exits.length >= BURST ? BACKOFF_MS : RESTART_MS;
      if (wait === BACKOFF_MS) stamp(`${exits.length} exits in ${BURST_WINDOW_MS / 1000}s, waiting ${BACKOFF_MS / 1000}s`);
      setTimeout(launch, wait);
    });
  };

  const finish = () => {
    try {
      fs.unlinkSync(STOPFILE);
    } catch {}
    try {
      fs.unlinkSync(PIDFILE);
    } catch {}
    stamp('stopped');
    process.exit(0);
  };

  // A 1 s poll, not fs.watch: it has to work on every drive and filesystem.
  setInterval(() => {
    if (stopping || !fs.existsSync(STOPFILE)) return;
    stopping = true;
    stamp('stop requested');
    if (!server) return finish();
    try {
      server.send({ type: 'shutdown', reason: 'stop requested' });
    } catch {}
    setTimeout(() => {
      if (server) {
        stamp('server did not exit in time, killing it');
        server.kill();
      }
    }, STOP_GRACE_MS).unref();
  }, 1_000);

  launch();
}

// Write the logon script into the user's Startup folder. An existing
// kungfu-kanban.cmd with other content is kept as kungfu-kanban.cmd.bak.
function install() {
  const dir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  if (!process.env.APPDATA || !fs.existsSync(dir)) {
    console.error(`no Startup folder at ${dir}`);
    process.exitCode = 1;
    return;
  }
  const file = path.join(dir, 'kungfu-kanban.cmd');
  const body = [
    '@echo off',
    'rem Starts Kungfu Kanban at logon with no console window to close.',
    'rem Written by scripts\\windows\\supervise.js --install.',
    `rem Stop: node scripts\\windows\\supervise.js --stop   Log: ${LOG}`,
    `cd /d "${ROOT}"`,
    `"${process.execPath}" scripts\\windows\\supervise.js`,
    '',
  ].join('\r\n');
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    if (old === body) return console.log(`${file} is already current`);
    fs.writeFileSync(`${file}.bak`, old);
    console.log(`kept the old one as ${file}.bak`);
  }
  fs.writeFileSync(file, body);
  console.log(`wrote ${file}`);
}

const arg = process.argv[2];
if (arg === '--run') supervise();
else if (arg === '--install') install();
else if (arg === '--stop') stop();
else if (arg === '--status') {
  const pid = runningPid();
  console.log(pid ? `running (supervisor pid ${pid})` : 'not running');
} else start();
