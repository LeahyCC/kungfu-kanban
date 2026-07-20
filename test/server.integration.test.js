// Boots the REAL server.js as a child process and exercises the HTTP
// contract end to end. Isolation: PORT is a random ephemeral port (retried
// on clash), HOST is loopback-only, and cwd is this checkout — so its data/
// dir (created fresh by lib/store.js) is this checkout's own, never the
// live board's data on :4747.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { parseSchedule, scheduleDue } = require('../lib/schedule');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TEST_TOKEN = 'kfk-integration-test-token';

function wipeData() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

// One boot attempt on a random high port. Resolves the running {child, base}
// once the server answers any HTTP response, or null if it never came up
// (port clash or slow CI) so the caller can retry on a fresh port.
function tryBoot(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 30000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      // KFK_TEST skips boot-time skill auto-install — this checkout's absolute
      // paths + random test port must never overwrite ~/.claude/skills/kungfu-todo.
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', KFK_TEST: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let settled = false;
    child.once('exit', () => {
      if (settled) return;
      settled = true;
      if (/EADDRINUSE/.test(stderr)) resolve(null);
      else reject(new Error(`test server exited before it came up:\n${stderr.slice(-800)}`));
    });

    const deadline = Date.now() + 15_000;
    (async function poll() {
      while (!settled && Date.now() < deadline) {
        try {
          await fetch(`${base}/api/config`);
          settled = true;
          return resolve({ child, base });
        } catch {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve(null);
      }
    })();
  });
}

async function bootServer(env = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await tryBoot(env);
    if (result) return result;
  }
  throw new Error('could not boot test server after 5 attempts (port contention?)');
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function postJson(base, path_, body) {
  return fetch(`${base}${path_}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}
async function patchJson(base, path_, body) {
  return fetch(`${base}${path_}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
}
async function putJson(base, path_, body) {
  return fetch(`${base}${path_}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

// --- lib/schedule (no server needed) ----------------------------------------

describe('lib/schedule', () => {
  test('parseSchedule — daily HH:MM', () => {
    assert.deepEqual(parseSchedule('9:30'), { kind: 'daily', time: '09:30', lastFired: null });
  });

  test('parseSchedule — interval hours ("6h")', () => {
    assert.deepEqual(parseSchedule('6h'), { kind: 'interval', hours: 6, lastFired: null });
    assert.deepEqual(parseSchedule('1.5'), { kind: 'interval', hours: 1.5, lastFired: null });
  });

  test('parseSchedule — invalid shapes return null', () => {
    assert.equal(parseSchedule('25:00'), null);
    assert.equal(parseSchedule('12:60'), null);
    assert.equal(parseSchedule('not a schedule'), null);
    assert.equal(parseSchedule('0h'), null);
    assert.equal(parseSchedule(''), null);
    assert.equal(parseSchedule(null), null);
    assert.equal(parseSchedule({}), null);
  });

  test('parseSchedule — an already-normalized object passes through idempotently', () => {
    const obj = { kind: 'daily', time: '10:00', lastFired: '2026-01-01T00:00:00.000Z' };
    assert.deepEqual(parseSchedule(obj), obj);
  });

  test('scheduleDue — daily: due once past the target time, once per day', () => {
    const now = new Date('2026-07-20T15:00:00');
    assert.equal(scheduleDue({ schedule: { kind: 'daily', time: '16:00', lastFired: null } }, now), false);
    assert.equal(scheduleDue({ schedule: { kind: 'daily', time: '09:00', lastFired: null } }, now), true);
    assert.equal(
      scheduleDue({ schedule: { kind: 'daily', time: '09:00', lastFired: new Date('2026-07-20T09:00:01').toISOString() } }, now),
      false
    );
    assert.equal(
      scheduleDue({ schedule: { kind: 'daily', time: '09:00', lastFired: new Date('2026-07-19T09:00:01').toISOString() } }, now),
      true
    );
  });

  test('scheduleDue — interval: due once enough hours have elapsed', () => {
    const now = new Date('2026-07-20T15:00:00');
    assert.equal(
      scheduleDue({ createdAt: new Date('2026-07-20T14:00:00').toISOString(), schedule: { kind: 'interval', hours: 6, lastFired: null } }, now),
      false
    );
    assert.equal(
      scheduleDue({ createdAt: new Date('2026-07-20T08:00:00').toISOString(), schedule: { kind: 'interval', hours: 6, lastFired: null } }, now),
      true
    );
  });

  test('scheduleDue — no schedule, or an unknown kind, is never due', () => {
    assert.equal(scheduleDue({ schedule: null }, new Date()), false);
    assert.equal(scheduleDue({ schedule: { kind: 'weekly' } }, new Date()), false);
  });
});

// --- HTTP contract, unauthenticated board -----------------------------------

// Safety skip: these two describes wipe and rewrite data/. Checked BEFORE
// anything below ever touches the filesystem — if this checkout's data/
// already holds a real token or real cards, two servers sharing one data
// dir would corrupt live state, so refuse instead of guessing.
const liveDataReason = (() => {
  try {
    if (fs.existsSync(path.join(DATA_DIR, 'auth-token'))) return 'data/auth-token already exists';
    const tasks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf8'));
    if (Array.isArray(tasks) && tasks.length) return 'data/tasks.json is non-empty';
  } catch {
    // no data/ yet, or unreadable — nothing live to protect
  }
  return null;
})();

if (liveDataReason) {
  test(`server integration suite skipped — ${liveDataReason}; this looks like a live checkout, refusing to wipe data/`, { skip: true }, () => {});
} else {

describe('HTTP contract (no auth gate)', () => {
  let child, base;

  before(async () => {
    wipeData();
    ({ child, base } = await bootServer());
    // The Sensei is enabled by default with onNewCard triggers — first API
    // call after boot, before any task-creating test, so a POST /api/tasks
    // below never fans out into a real `claude -p` invocation.
    await putJson(base, '/api/manager/config', { enabled: false });
  });

  after(async () => {
    await killChild(child);
  });

  test('GET /api/config — 200 with the expected shape', async () => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.models));
    assert.ok(Array.isArray(body.efforts));
    assert.ok(Array.isArray(body.permissionModes));
    assert.ok(Array.isArray(body.skills));
    assert.ok(Array.isArray(body.agents));
    assert.ok(Array.isArray(body.repos));
    assert.equal(typeof body.settings, 'object');
    assert.equal(typeof body.cooldownUntil, 'number');
    assert.equal(typeof body.modelBlocks, 'object');
    assert.equal(body.authGate, false);
  });

  test('POST /api/tasks — coerces an overlong title and an invalid priority', async () => {
    const longTitle = 'x'.repeat(250);
    const res = await postJson(base, '/api/tasks', { title: longTitle, priority: 'urgent' });
    assert.equal(res.status, 200);
    const task = await res.json();
    assert.equal(task.title, longTitle.slice(0, 200));
    assert.equal(task.priority, 0);
    assert.equal(task.status, 'backlog');
  });

  test('PATCH /api/tasks/:id — status cannot be set directly to running or stopping', async () => {
    const created = await (await postJson(base, '/api/tasks', { title: 'patch target' })).json();
    for (const status of ['running', 'stopping']) {
      const res = await patchJson(base, `/api/tasks/${created.id}`, { status });
      assert.equal(res.status, 400);
    }
  });

  test('PATCH /api/tasks/:id — a dependency cycle is rejected', async () => {
    const a = await (await postJson(base, '/api/tasks', { title: 'A' })).json();
    const b = await (await postJson(base, '/api/tasks', { title: 'B' })).json();
    const first = await patchJson(base, `/api/tasks/${b.id}`, { deps: [a.id] });
    assert.equal(first.status, 200);
    const second = await patchJson(base, `/api/tasks/${a.id}`, { deps: [b.id] });
    assert.equal(second.status, 400);
    const body = await second.json();
    assert.match(body.error, /cycle/);
  });

  test('PATCH /api/tasks/:id — an overlong title is re-sliced to 200 chars', async () => {
    const created = await (await postJson(base, '/api/tasks', { title: 'short' })).json();
    const res = await patchJson(base, `/api/tasks/${created.id}`, { title: 'y'.repeat(300) });
    assert.equal(res.status, 200);
    const task = await res.json();
    assert.equal(task.title.length, 200);
  });

  test('GET /api/tasks/:id/transcript — a traversal-shaped id is 404', async () => {
    const res = await fetch(`${base}/api/tasks/${encodeURIComponent('../../etc/passwd')}/transcript`);
    assert.equal(res.status, 404);
  });

  test('POST /api/tasks/:id/stop — 409 on an idle card', async () => {
    const created = await (await postJson(base, '/api/tasks', { title: 'idle card' })).json();
    const res = await fetch(`${base}/api/tasks/${created.id}/stop`, { method: 'POST' });
    assert.equal(res.status, 409);
  });

  test('PUT /api/settings — maxConcurrent out of range is ignored', async () => {
    const baseline = await (await putJson(base, '/api/settings', { maxConcurrent: 3 })).json();
    assert.equal(baseline.maxConcurrent, 3);
    const tooHigh = await (await putJson(base, '/api/settings', { maxConcurrent: 99 })).json();
    assert.equal(tooHigh.maxConcurrent, 3);
    const tooLow = await (await putJson(base, '/api/settings', { maxConcurrent: 0 })).json();
    assert.equal(tooLow.maxConcurrent, 3);
  });

  test('PUT /api/settings — maxRunMinutes bounds are enforced', async () => {
    const baseline = await (await putJson(base, '/api/settings', { maxRunMinutes: 45 })).json();
    assert.equal(baseline.maxRunMinutes, 45);
    const negative = await (await putJson(base, '/api/settings', { maxRunMinutes: -1 })).json();
    assert.equal(negative.maxRunMinutes, 45);
    const tooHigh = await (await putJson(base, '/api/settings', { maxRunMinutes: 1441 })).json();
    assert.equal(tooHigh.maxRunMinutes, 45);
  });

  test('PUT /api/manager/config — invalid enum values are ignored', async () => {
    const baseline = await (await putJson(base, '/api/manager/config', { model: 'sonnet', autonomy: 'semi' })).json();
    assert.equal(baseline.model, 'sonnet');
    assert.equal(baseline.autonomy, 'semi');
    const rejected = await (await putJson(base, '/api/manager/config', { model: 'not-a-model', autonomy: 'yolo' })).json();
    assert.equal(rejected.model, 'sonnet');
    assert.equal(rejected.autonomy, 'semi');
  });
});

// --- Auth gate ---------------------------------------------------------------

describe('auth gate', () => {
  let child, base;

  before(async () => {
    wipeData();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'auth-token'), TEST_TOKEN);
    ({ child, base } = await bootServer());
  });

  after(async () => {
    await killChild(child);
    wipeData();
  });

  test('no Authorization header — 401 on /api/*', async () => {
    const res = await fetch(`${base}/api/tasks`);
    assert.equal(res.status, 401);
  });

  test('wrong bearer token — 401', async () => {
    const res = await fetch(`${base}/api/tasks`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(res.status, 401);
  });

  test('correct bearer token — 200', async () => {
    const res = await fetch(`${base}/api/tasks`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    assert.equal(res.status, 200);
  });

  test('/login — 200 without auth', async () => {
    const res = await fetch(`${base}/login`);
    assert.equal(res.status, 200);
  });
});

}
