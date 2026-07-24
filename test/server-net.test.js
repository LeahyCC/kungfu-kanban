// Network/SSE contract tests: boots the REAL server.js as a child process
// (same conventions as test/server.integration.test.js — random high port,
// loopback only, KFK_DATA_DIR in a fresh os.tmpdir(), boot-poll /api/config,
// SIGTERM teardown) and exercises the perf/overhaul network surface:
// slim SSE task projections + version stamping, 250ms per-id coalescing,
// conditional GET /api/tasks, GET /api/tasks/:id, gzip, and cache headers.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function mkTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-test-'));
}

function tryBoot(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 30000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', KFK_TEST: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let settled = false;
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (/EADDRINUSE/.test(stderr)) return resolve({ ok: false, detail: 'port already in use' });
      reject(new Error(`test server exited before it came up (code ${code}, signal ${signal}):\n${stderr.slice(-1000)}`));
    });

    const deadline = Date.now() + 15_000;
    (async function poll() {
      while (!settled && Date.now() < deadline) {
        try {
          await fetch(`${base}/api/config`);
          settled = true;
          return resolve({ ok: true, child, base });
        } catch {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, detail: `server never answered ${base} within 15s` });
      }
    })();
  });
}

async function bootServer(env = {}) {
  let lastDetail = 'unknown';
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await tryBoot(env);
    if (result.ok) return result;
    lastDetail = result.detail;
  }
  throw new Error(`could not boot test server after 5 attempts — last failure: ${lastDetail}`);
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(base, path_, body) {
  return fetch(`${base}${path_}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}
async function patchJson(base, path_, body) {
  return fetch(`${base}${path_}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
}
async function putJson(base, path_, body) {
  return fetch(`${base}${path_}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

// Raw HTTP GET (no fetch auto-decompression, explicit headers) so gzip
// framing and cache headers can be asserted on the wire.
function rawGet(base, path_, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path_);
    const req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
  });
}

// Minimal SSE reader over fetch's body stream: parses `data: <json>\n\n`
// frames into an array and supports waiting for a matching frame.
async function openSse(base) {
  const res = await fetch(`${base}/api/events`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames = [];
  const waiters = new Set();
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const msg = JSON.parse(line.slice(6));
          frames.push(msg);
          for (const w of waiters) w(msg);
        }
      }
    } catch {
      // reader cancelled at test end — nothing to do
    }
  })();
  function waitFor(pred, timeout = 4000) {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(onMsg);
        reject(new Error(`timed out waiting for SSE frame; saw: ${JSON.stringify(frames.map((f) => f.type))}`));
      }, timeout);
      const onMsg = (msg) => {
        if (!pred(msg)) return;
        clearTimeout(timer);
        waiters.delete(onMsg);
        resolve(msg);
      };
      waiters.add(onMsg);
    });
  }
  return {
    frames,
    waitFor,
    contentEncoding: res.headers.get('content-encoding'),
    async close() {
      try {
        await reader.cancel();
      } catch {}
    },
  };
}

describe('network/SSE contract (no auth gate)', () => {
  let child, base, dataDir;

  before(async () => {
    dataDir = mkTempDataDir();
    ({ child, base } = await bootServer({ KFK_DATA_DIR: dataDir }));
    // Sensei is enabled by default — neuter it before any POST /api/tasks so
    // no test card fans out into a real `claude -p` invocation.
    await putJson(base, '/api/manager/config', { enabled: false });
  });

  after(async () => {
    await killChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('SSE task frames are slim projections (no prompt/resultText/acceptanceCriteria) with monotonically increasing v', async () => {
    const sse = await openSse(base);
    try {
      const prompt = `secret prompt ${'x'.repeat(3000)}`;
      const created = await (
        await postJson(base, '/api/tasks', { title: 'sse-slim', prompt, acceptanceCriteria: 'tests pass' })
      ).json();
      // the HTTP create response stays full...
      assert.equal(created.prompt, prompt);

      const isFor = (m) => m.type === 'task' && m.task && m.task.id === created.id;
      const f1 = await sse.waitFor(isFor);
      // ...but the SSE frame is a slim projection. The slim flag rides the TASK,
      // not the frame — the client's mergeTaskPayload reads incoming.full (on the
      // task) to keep the omitted heavy fields. On the frame it was invisible
      // client-side, so every slim frame wiped prompt/resultText/acceptanceCriteria.
      assert.equal(f1.task.full, false, 'slim flag must ride the task, where the client reads it');
      assert.ok(!('prompt' in f1.task), 'prompt must not ride SSE');
      assert.ok(!('resultText' in f1.task), 'resultText must not ride SSE');
      assert.ok(!('acceptanceCriteria' in f1.task), 'acceptanceCriteria must not ride SSE');
      assert.equal(f1.task.id, created.id);
      assert.equal(f1.task.title, 'sse-slim');
      assert.equal(f1.task.status, 'backlog');
      assert.equal(typeof f1.task.v, 'number');

      await patchJson(base, `/api/tasks/${created.id}`, { title: 'sse-slim-v2' });
      const f2 = await sse.waitFor((m) => isFor(m) && m.task.title === 'sse-slim-v2');
      assert.ok(f2.task.v > f1.task.v, `v must increase (${f1.task.v} -> ${f2.task.v})`);
    } finally {
      await sse.close();
    }
  });

  test('coalescing: 3 rapid PATCHes within 250ms collapse to exactly 1 task frame (last-write-wins)', async () => {
    const sse = await openSse(base);
    try {
      const created = await (await postJson(base, '/api/tasks', { title: 'coalesce-target' })).json();
      const isFor = (m) => m.type === 'task' && m.task && m.task.id === created.id;
      await sse.waitFor(isFor); // create frame flushed; coalescing window closed
      const baseline = sse.frames.length;

      // Sequential awaits on loopback land well inside one 250ms window, and
      // guarantee the arrival order the last-write-wins assertion relies on.
      await patchJson(base, `/api/tasks/${created.id}`, { title: 'burst-1' });
      await patchJson(base, `/api/tasks/${created.id}`, { title: 'burst-2' });
      await patchJson(base, `/api/tasks/${created.id}`, { title: 'burst-3' });

      await waitMs(900); // one 250ms trailing window + generous slack
      const burstFrames = sse.frames.slice(baseline).filter(isFor);
      assert.equal(burstFrames.length, 1, `expected 1 coalesced frame, got ${burstFrames.length}`);
      assert.equal(burstFrames[0].task.title, 'burst-3');
    } finally {
      await sse.close();
    }
  });

  test('a delete flushes a pending coalesced task frame before the deleted frame', async () => {
    const sse = await openSse(base);
    try {
      const created = await (await postJson(base, '/api/tasks', { title: 'delete-flush' })).json();
      const isFor = (m) => m.type === 'task' && m.task && m.task.id === created.id;
      await sse.waitFor(isFor);
      const baseline = sse.frames.length;

      await patchJson(base, `/api/tasks/${created.id}`, { title: 'delete-flush-v2' }); // lands in the window
      await fetch(`${base}/api/tasks/${created.id}`, { method: 'DELETE' }); // before the window closes

      await waitMs(700);
      const tail = sse.frames.slice(baseline);
      const taskIdx = tail.findIndex(isFor);
      const delIdx = tail.findIndex((m) => m.type === 'deleted' && m.taskId === created.id);
      assert.ok(taskIdx !== -1, 'pending task frame should be flushed, not dropped');
      assert.ok(delIdx !== -1, 'deleted frame expected');
      assert.ok(taskIdx < delIdx, 'stale task frame must never arrive after its delete');
    } finally {
      await sse.close();
    }
  });

  test('a delete advances the board version — a stale ?v= refetches instead of 304 (no ghost cards)', async () => {
    const created = await (await postJson(base, '/api/tasks', { title: 'delete-bumps-version' })).json();
    const verBefore = (await fetch(`${base}/api/tasks`)).headers.get('x-board-version');
    // sanity: right now that version is up to date, so it 304s
    assert.equal((await fetch(`${base}/api/tasks?v=${verBefore}`)).status, 304);

    await fetch(`${base}/api/tasks/${created.id}`, { method: 'DELETE' });

    // the board lost a card — a client still holding the pre-delete version must
    // get the full board (200), never a 304 that would strand a ghost card.
    const r = await fetch(`${base}/api/tasks?v=${verBefore}`);
    assert.equal(r.status, 200, 'pre-delete version must not 304 after a delete');
    const body = await r.json();
    assert.ok(!body.some((t) => t.id === created.id), 'deleted card must be absent from the refetch');
  });

  test('GET /api/tasks — X-Board-Version header, ?v=<current> -> 304, ?v=<stale> -> 200', async () => {
    // a task exists from earlier tests, so seq > 0
    const r1 = await fetch(`${base}/api/tasks`);
    assert.equal(r1.status, 200);
    const ver = r1.headers.get('x-board-version');
    assert.ok(ver && Number(ver) > 0, `expected a positive board version, got ${ver}`);
    const body = await r1.json();
    assert.ok(Array.isArray(body));

    const r2 = await fetch(`${base}/api/tasks?v=${ver}`);
    assert.equal(r2.status, 304);
    assert.equal(await r2.text(), '');

    const r3 = await fetch(`${base}/api/tasks?v=0`);
    assert.equal(r3.status, 200);
    assert.equal(r3.headers.get('x-board-version'), ver);
    await r3.json();
  });

  test('GET /api/tasks/:id — full task incl. prompt; 404 for unknown id', async () => {
    const prompt = `drawer prompt ${'y'.repeat(1500)}`;
    const created = await (
      await postJson(base, '/api/tasks', { title: 'drawer-target', prompt, acceptanceCriteria: 'ac-here' })
    ).json();

    const res = await fetch(`${base}/api/tasks/${created.id}`);
    assert.equal(res.status, 200);
    const full = await res.json();
    assert.equal(full.prompt, prompt);
    assert.equal(full.acceptanceCriteria, 'ac-here');

    const missing = await fetch(`${base}/api/tasks/00000000-0000-0000-0000-000000000000`);
    assert.equal(missing.status, 404);
  });

  test('gzip: style.css compresses with correct headers; identity without Accept-Encoding; SSE never compressed', async () => {
    const disk = fs.readFileSync(path.join(ROOT, 'public', 'style.css'));

    const gz = await rawGet(base, '/style.css', { 'Accept-Encoding': 'gzip' });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(String(gz.headers.vary), /Accept-Encoding/);
    assert.ok(!gz.headers['content-length'], 'chunked streaming — no buffered Content-Length');
    assert.deepEqual(zlib.gunzipSync(gz.body), disk);
    assert.ok(gz.body.length < disk.length, 'gzip should actually shrink 43KB of CSS');

    const plain = await rawGet(base, '/style.css');
    assert.equal(plain.status, 200);
    assert.ok(!plain.headers['content-encoding']);
    assert.deepEqual(plain.body, disk);

    // JSON API responses compress too
    const api = await rawGet(base, '/api/tasks', { 'Accept-Encoding': 'gzip' });
    assert.equal(api.headers['content-encoding'], 'gzip');
    assert.ok(Array.isArray(JSON.parse(zlib.gunzipSync(api.body).toString('utf8'))));

    // /api/events must never be compressed/buffered, even when gzip is offered
    const sse = await openSse(base);
    try {
      assert.equal(sse.contentEncoding, null);
    } finally {
      await sse.close();
    }
  });

  test('cache headers: no-cache for html/js/css, immutable day-cache for images', async () => {
    const js = await rawGet(base, '/app.js');
    assert.equal(js.headers['cache-control'], 'no-cache');
    const css = await rawGet(base, '/style.css');
    assert.equal(css.headers['cache-control'], 'no-cache');
    const html = await rawGet(base, '/index.html');
    assert.equal(html.headers['cache-control'], 'no-cache');
    const png = await rawGet(base, '/logo.png');
    assert.equal(png.headers['cache-control'], 'max-age=86400, immutable');
    const ico = await rawGet(base, '/favicon.ico');
    assert.equal(ico.headers['cache-control'], 'max-age=86400, immutable');
  });
});
