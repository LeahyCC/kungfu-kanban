#!/usr/bin/env node
/* perf-measure.js — server-side performance measurements against the
 * ISOLATED kungfu-kanban instance (never port 4747).
 *
 * Subcommands:
 *   http   GET /api/tasks latency p50/p95 (30 runs) + payload bytes;
 *          static-asset response headers & transfer sizes
 *   sse    connect /api/events, churn task mutations, count events/bytes/rate
 *   churn  only drive mutations (3-lane "running cards" simulation) — used as
 *          the background driver while the browser is instrumented
 *   soak   long-running light churn for heap-soak windows (default 180s)
 *   all    http + sse
 *
 * Usage: node scripts/perf-measure.js <cmd> [--port 4848] [--runs 30]
 *        [--duration 30] [--out scratch/perf/measure.json]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const CMD = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const PORT = Number(opt('port', 4848));
const RUNS = Number(opt('runs', 30));
const DURATION = Number(opt('duration', 30)); // seconds
const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'scratch', 'perf', 'measure.json')));

if (PORT === 4747) {
  console.error('REFUSING to measure port 4747 (production).');
  process.exit(1);
}

function request(method, p, { body, headers = {}, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method, headers },
      (res) => {
        if (stream) return resolve({ res, headers: res.headers });
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            bytes: Buffer.concat(chunks).length,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

// ---------------------------------------------------------------- http ----
async function measureHttp() {
  const out = { apiTasks: {}, static: {} };

  // warm up
  await request('GET', '/api/tasks');
  const lat = [];
  let payload = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = await request('GET', '/api/tasks');
    lat.push(performance.now() - t0);
    payload = r.bytes;
  }
  out.apiTasks = {
    runs: RUNS,
    p50ms: +percentile(lat, 50).toFixed(2),
    p95ms: +percentile(lat, 95).toFixed(2),
    minMs: +Math.min(...lat).toFixed(2),
    maxMs: +Math.max(...lat).toFixed(2),
    payloadBytes: payload,
    payloadKB: +(payload / 1024).toFixed(1),
  };

  for (const p of ['/', '/app.js', '/js/board.js', '/style.css']) {
    // ask for gzip to see whether the server compresses at all
    const r = await request('GET', p, { headers: { 'Accept-Encoding': 'gzip, deflate' } });
    out.static[p] = {
      status: r.status,
      bytes: r.bytes,
      cacheControl: r.headers['cache-control'] || null,
      etag: r.headers.etag || null,
      lastModified: r.headers['last-modified'] || null,
      contentEncoding: r.headers['content-encoding'] || null,
      contentType: r.headers['content-type'] || null,
    };
  }
  return out;
}

// --------------------------------------------------------------- churn ----
// Simulates 3 running cards: 3 lanes, each PATCHing a distinct task at a
// realistic broadcast cadence (runner emits ≤1 task event / 2s per card for
// telemetry plus output bursts; we drive ~2 PATCH/s per lane = ~6 events/s).
async function churn(durationSec, { quiet = false, lanes = 3, intervalMs = 500 } = {}) {
  const tasks = JSON.parse((await request('GET', '/api/tasks')).body);
  const backlog = tasks.filter((t) => t.status === 'backlog').slice(0, lanes);
  if (backlog.length < lanes) throw new Error('not enough backlog cards to churn');
  const deadline = Date.now() + durationSec * 1000;
  let mutations = 0;
  const tick = async (t) => {
    let i = 0;
    while (Date.now() < deadline) {
      // alternate a cheap field so every PATCH changes the fingerprint, like
      // real liveOut/ctxTokens telemetry would
      await request('PATCH', `/api/tasks/${t.id}`, {
        body: { priority: (i++ % 2) + 1 },
        headers: { 'Content-Type': 'application/json' },
      });
      mutations++;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  await Promise.all(backlog.map(tick));
  if (!quiet) console.log(`churn: ${mutations} mutations in ${durationSec}s (${(mutations / durationSec).toFixed(1)}/s)`);
  return mutations;
}

// ----------------------------------------------------------------- sse ----
async function measureSse() {
  const { res } = await request('GET', '/api/events', {
    headers: { Accept: 'text/event-stream' },
    stream: true,
  });
  let events = 0;
  let bytes = 0;
  let taskEvents = 0;
  let buf = '';
  res.on('data', (c) => {
    bytes += c.length;
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (frame.startsWith('data:')) {
        events++;
        try {
          if (JSON.parse(frame.slice(5)).type === 'task') taskEvents++;
        } catch {}
      }
    }
  });

  const t0 = Date.now();
  const mutations = await churn(DURATION, { quiet: true });
  const secs = (Date.now() - t0) / 1000;
  res.destroy();

  // drain small race: count what arrived (close enough for a baseline)
  return {
    durationS: +secs.toFixed(1),
    mutations,
    sseEvents: events,
    taskEvents,
    totalBytes: bytes,
    bytesPerEvent: events ? Math.round(bytes / events) : 0,
    eventsPerSec: +(events / secs).toFixed(1),
  };
}

// ----------------------------------------------------------------- all ----
async function main() {
  const results = {};
  if (CMD === 'http' || CMD === 'all') {
    results.http = await measureHttp();
    const h = results.http;
    console.log('\n== GET /api/tasks ==');
    console.log(`  runs=${h.apiTasks.runs}  p50=${h.apiTasks.p50ms}ms  p95=${h.apiTasks.p95ms}ms  min=${h.apiTasks.minMs}ms  max=${h.apiTasks.maxMs}ms`);
    console.log(`  payload: ${h.apiTasks.payloadBytes} bytes (${h.apiTasks.payloadKB} KB)`);
    console.log('\n== static assets ==');
    for (const [p, s] of Object.entries(h.static)) {
      console.log(`  ${p}`);
      console.log(`    ${s.status} ${s.bytes}B  type=${s.contentType}`);
      console.log(`    Cache-Control: ${s.cacheControl ?? '—'}  ETag: ${s.etag ?? '—'}  Content-Encoding: ${s.contentEncoding ?? '—'}  Last-Modified: ${s.lastModified ?? '—'}`);
    }
  }
  if (CMD === 'sse' || CMD === 'all') {
    results.sse = await measureSse();
    const s = results.sse;
    console.log('\n== SSE /api/events (3-lane churn) ==');
    console.log(`  window=${s.durationS}s  mutations=${s.mutations}  events=${s.sseEvents} (task=${s.taskEvents})`);
    console.log(`  bytes=${s.totalBytes}  bytes/event=${s.bytesPerEvent}  events/s=${s.eventsPerSec}`);
  }
  if (CMD === 'churn') {
    await churn(DURATION);
    return;
  }
  if (CMD === 'soak') {
    await churn(DURATION, { lanes: 1, intervalMs: 2000 });
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), port: PORT, ...results }, null, 2));
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => {
  console.error('measure failed:', e.message);
  process.exit(1);
});
