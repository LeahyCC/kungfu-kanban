#!/usr/bin/env node
/* perf-browser.js — browser-side render-cost baseline for the ISOLATED
 * kungfu-kanban instance, driven over raw CDP (no puppeteer) against a
 * dedicated headless Chrome with a throwaway profile in scratch/.
 *
 * Why CDP: the kimi-webbridge extension was not connected to the user's real
 * Chrome at baseline time, so this stands in. Same page, same JS, real Blink
 * rendering — just headless.
 *
 * Chrome is launched ONCE (subcommand `launch`, detached) and kept up across
 * subcommands so each Bash call stays short:
 *
 *   node scripts/perf-browser.js launch            # start chrome + instrument
 *   node scripts/perf-browser.js churn-window      # 60s: 3-lane churn, longtasks, FPS, memory
 *   node scripts/perf-browser.js drawer <taskId>   # drawer-open cost on big transcript
 *   node scripts/perf-browser.js filter            # 10-keystroke filter cost
 *   node scripts/perf-browser.js soak              # 3-min heap soak under light churn
 *   node scripts/perf-browser.js kill              # shut chrome down
 *
 * Options: --port 4848 (app), --cdp 9223, --duration N (seconds)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const CMD = args[0] && !args[0].startsWith('--') ? args[0] : 'launch';
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const APP_PORT = Number(opt('port', 4848));
const CDP_PORT = Number(opt('cdp', 9223));
const DURATION = Number(opt('duration', 60));
const PREFIX = opt('prefix', ''); // e.g. --prefix final- keeps baseline artifacts intact
const APP_URL = `http://localhost:${APP_PORT}/`;
const PROFILE = path.join(ROOT, 'scratch', 'perf', 'chrome-profile');
const OUT_DIR = path.join(ROOT, 'scratch', 'perf');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (APP_PORT === 4747) {
  console.error('REFUSING to point at production port 4747.');
  process.exit(1);
}

// --- minimal CDP client over Node's built-in WebSocket ----------------------
let msgId = 0;
async function connect() {
  // find the page target for our app URL
  let targets;
  for (let i = 0; i < 20; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      if (targets.some((t) => t.type === 'page' && t.url.startsWith(APP_URL))) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const page = (targets || []).find((t) => t.type === 'page' && t.url.startsWith(APP_URL));
  if (!page) throw new Error(`no CDP page target for ${APP_URL} on port ${CDP_PORT} (run 'launch' first)`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws connect failed'));
  });
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('page JS threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  };
  return { ws, send, evaluate };
}

// Instrumentation installed into the page: longtask observer, rAF FPS
// counter, performance.memory sampler. Survives until navigation.
const INSTALL = `(() => {
  if (window.__perf) return 'already installed';
  const P = window.__perf = {
    longtasks: [],       // {start, duration}
    frames: 0,
    frameStart: performance.now(),
    memSamples: [],      // {t, used, total}
    mark() { return { n: this.longtasks.length, t: performance.now() }; },
    since(m) {
      const lt = this.longtasks.slice(m.n);
      return {
        wallMs: +(performance.now() - m.t).toFixed(1),
        longtaskCount: lt.length,
        longtaskMs: +lt.reduce((s, e) => s + e.duration, 0).toFixed(1),
        longtaskMax: lt.length ? +Math.max(...lt.map(e => e.duration)).toFixed(1) : 0,
      };
    },
    reset() { this.longtasks = []; this.frames = 0; this.frameStart = performance.now(); },
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.longtasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { P.longtaskError = String(e); }
  const raf = () => { P.frames++; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  if (performance.memory) {
    const s = () => P.memSamples.push({ t: Date.now(), used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize });
    s();
    setInterval(s, 5000);
  }
  return 'installed';
})()`;

async function waitForBoard(evaluate) {
  for (let i = 0; i < 60; i++) {
    const n = await evaluate(`document.querySelectorAll('.card').length`).catch(() => 0);
    if (n > 0) return n;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('board never rendered cards');
}

function writeOut(name, obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const f = path.join(OUT_DIR, PREFIX + name);
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...obj }, null, 2));
  console.log(`wrote ${f}`);
}

// ------------------------------------------------------------ commands ----
async function launch() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const log = fs.openSync(path.join(OUT_DIR, 'chrome.log'), 'a');
  const child = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--js-flags=--expose-gc',
    '--window-size=1440,900',
    '--no-first-run',
    APP_URL,
  ], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  console.log(`chrome pid ${child.pid} (headless, cdp :${CDP_PORT}, profile ${PROFILE})`);
  const { ws, evaluate } = await connect();
  console.log('instrumentation:', await evaluate(INSTALL));
  const cards = await waitForBoard(evaluate);
  console.log(`board up: ${cards} cards rendered`);
  ws.close();
}

async function churnWindow() {
  const { ws, evaluate } = await connect();
  await evaluate(INSTALL); // idempotent; SW-triggered reloads wipe window.__perf
  await evaluate(`window.__perf.reset(), 'reset'`);
  const m0 = await evaluate(`window.__perf.mark()`);
  const mem0 = await evaluate(`performance.memory ? performance.memory.usedJSHeapSize : null`);
  // drive 3-lane churn + count SSE events server-side, same window
  const sseFile = path.join(OUT_DIR, PREFIX + 'browser-sse.json');
  execSync(
    `node "${path.join(ROOT, 'scripts', 'perf-measure.js')}" sse --port ${APP_PORT} --duration ${DURATION} --out "${sseFile}"`,
    { stdio: 'inherit' }
  );
  const stats = await evaluate(`window.__perf.since(${JSON.stringify(m0)})`);
  const fps = await evaluate(`+(window.__perf.frames / ((performance.now() - window.__perf.frameStart) / 1000)).toFixed(1)`);
  const mem1 = await evaluate(`performance.memory ? performance.memory.usedJSHeapSize : null`);
  const sse = JSON.parse(fs.readFileSync(sseFile, 'utf8')).sse;
  const out = {
    windowS: DURATION,
    sseEvents: sse.sseEvents,
    ...stats,
    longtaskMsPerSseEvent: sse.sseEvents ? +(stats.longtaskMs / sse.sseEvents).toFixed(2) : null,
    fps,
    heapStartMB: mem0 ? +(mem0 / 1048576).toFixed(1) : null,
    heapEndMB: mem1 ? +(mem1 / 1048576).toFixed(1) : null,
  };
  console.log(JSON.stringify(out, null, 2));
  writeOut('browser-churn.json', out);
  ws.close();
}

async function drawer(taskId) {
  const { ws, evaluate } = await connect();
  await evaluate(INSTALL); // idempotent; SW-triggered reloads wipe window.__perf
  // click the card, then wait until: drawer open + transcript rendered +
  // 600ms with no new longtask (layout settled)
  const r = await evaluate(`(async () => {
    const P = window.__perf;
    const sel = '.card[data-id="${taskId}"]';
    const card = document.querySelector(sel);
    if (!card) return { error: 'card not on board: ' + sel };
    const m = P.mark();
    card.click();
    const t0 = performance.now();
    let settled = false, lastLt = P.longtasks.length, quietSince = performance.now();
    while (performance.now() - t0 < 30000) {
      await new Promise((r) => setTimeout(r, 100));
      const open = !document.getElementById('drawer').classList.contains('hidden');
      const entries = document.getElementById('transcript').children.length;
      if (P.longtasks.length !== lastLt) { lastLt = P.longtasks.length; quietSince = performance.now(); }
      if (open && entries > 0 && performance.now() - quietSince > 600) { settled = true; break; }
    }
    const openAt = performance.now();
    return {
      settled,
      entries: document.getElementById('transcript').children.length,
      ...P.since(m),
      clickToSettledMs: +(openAt - t0 - 600).toFixed(1), // subtract the quiet window
    };
  })()`);
  console.log(JSON.stringify(r, null, 2));
  writeOut('browser-drawer.json', { taskId, ...r });
  // close the drawer for subsequent runs
  await evaluate(`document.getElementById('drawerClose').click(), 'closed'`).catch(() => {});
  ws.close();
}

async function filterCost() {
  const { ws, evaluate } = await connect();
  await evaluate(INSTALL); // idempotent; SW-triggered reloads wipe window.__perf
  const r = await evaluate(`(async () => {
    const P = window.__perf;
    const inp = document.getElementById('filterInput');
    inp.focus();
    inp.value = '';
    inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const word = 'perf-card';
    const m = P.mark();
    const perKey = [];
    for (const ch of word.split('')) {
      const km = P.mark();
      inp.value += ch;
      inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const s = P.since(km);
      perKey.push({ ch: inp.value, wallMs: s.wallMs, longtaskMs: s.longtaskMs });
    }
    const total = P.since(m);
    inp.value = '';
    inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return { keystrokes: word.length, ...total, perKey };
  })()`);
  console.log(JSON.stringify(r, null, 2));
  writeOut('browser-filter.json', r);
  ws.close();
}

async function soak() {
  const { ws, evaluate } = await connect();
  await evaluate(INSTALL); // idempotent; SW-triggered reloads wipe window.__perf
  await evaluate(`window.gc && window.gc(), 'gc'`);
  const h0 = await evaluate(`performance.memory.usedJSHeapSize`);
  // async spawn (not execSync): blocking the event loop for minutes starves
  // the CDP WebSocket and silently kills the harvest that follows
  await new Promise((res, rej) => {
    const c = spawn('node', [path.join(ROOT, 'scripts', 'perf-measure.js'), 'soak', '--port', String(APP_PORT), '--duration', String(DURATION)], { stdio: 'inherit' });
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error('soak churn exited ' + code))));
  });
  await evaluate(`window.gc && window.gc(), 'gc'`);
  const h1 = await evaluate(`performance.memory.usedJSHeapSize`);
  const samples = await evaluate(`window.__perf.memSamples.slice(-40)`);
  const out = {
    durationS: DURATION,
    heapStartMB: +(h0 / 1048576).toFixed(1),
    heapEndMB: +(h1 / 1048576).toFixed(1),
    growthMB: +((h1 - h0) / 1048576).toFixed(1),
    tailSamples: samples,
  };
  console.log(JSON.stringify({ ...out, tailSamples: `(${samples.length} samples in file)` }, null, 2));
  writeOut('browser-soak.json', out);
  ws.close();
}

// Synthesize a full HTML5 drag of a card across columns (backlog<->review,
// avoiding done's confirm dialog and queued's /run side effect), measuring
// wall time + longtasks until the card re-renders in the target column.
async function drag() {
  const { ws, evaluate } = await connect();
  await evaluate(INSTALL); // idempotent; SW-triggered reloads wipe window.__perf
  const trials = Number(opt('trials', 5));
  const r = await evaluate(`(async () => {
    const P = window.__perf;
    const trials = [];
    for (let i = 0; i < ${trials}; i++) {
      const fromStatus = i % 2 === 0 ? 'backlog' : 'review';
      const toStatus = i % 2 === 0 ? 'review' : 'backlog';
      const col = document.querySelector('.column[data-status="' + fromStatus + '"]');
      const target = document.querySelector('.column[data-status="' + toStatus + '"]');
      const card = col && col.querySelector('.card');
      if (!card || !target) { trials.push({ error: 'no card/column for ' + fromStatus + '->' + toStatus }); continue; }
      const id = card.dataset.id;
      const dt = new DataTransfer();
      const m = P.mark();
      const t0 = performance.now();
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire(card, 'dragstart');
      fire(target.querySelector('.col-body'), 'dragover');
      fire(target.querySelector('.col-body'), 'drop');
      fire(card, 'dragend');
      let ok = false;
      while (performance.now() - t0 < 10000) {
        await new Promise((r) => setTimeout(r, 50));
        // re-query: render() rebuilds board.innerHTML, so the pre-drop
        // column element is detached after the first re-render
        if (document.querySelector('.column[data-status="' + toStatus + '"] .card[data-id="' + id + '"]')) { ok = true; break; }
      }
      const s = P.since(m);
      trials.push({ from: fromStatus, to: toStatus, ok, ...s });
      // let the board settle between trials
      await new Promise((r) => setTimeout(r, 800));
    }
    return trials;
  })()`);
  const okTrials = (r || []).filter((t) => t.ok);
  const walls = okTrials.map((t) => t.wallMs).sort((a, b) => a - b);
  const median = walls.length ? walls[Math.floor(walls.length / 2)] : null;
  const out = {
    trials: r,
    okCount: okTrials.length,
    medianWallMs: median,
    medianLongtaskMs: okTrials.length ? okTrials.map((t) => t.longtaskMs).sort((a, b) => a - b)[Math.floor(okTrials.length / 2)] : null,
    maxWallMs: walls.length ? walls[walls.length - 1] : null,
  };
  console.log(JSON.stringify(out, null, 2));
  writeOut('browser-drag.json', out);
  ws.close();
}

// Per-SSE-event render() cost. v1.6.0+ exposes window.__kkPerf.renders
// ({t, ms, cards}, cap 500) natively — recorded only for render passes that
// actually do work (fingerprint-skip returns early, unrecorded). Falls back
// to window.__renderMs (worktree source instrumentation) on the old code.
async function renderCost() {
  const { ws, send, evaluate } = await connect();
  // reload so the page definitely runs the current board.js, then reset
  await send('Page.enable');
  await send('Page.navigate', { url: APP_URL });
  await new Promise((r) => setTimeout(r, 2000));
  await evaluate(INSTALL);
  const cards = await waitForBoard(evaluate);
  const source = await evaluate(`window.__kkPerf && window.__kkPerf.renders ? '__kkPerf' : (window.__renderMs ? '__renderMs' : 'none')`);
  if (source === 'none') throw new Error('no render instrumentation found (expected window.__kkPerf.renders)');
  await evaluate(
    source === '__kkPerf'
      ? `(window.__kkPerf.renders.length = 0), window.__perf.reset(), 'reset'`
      : `window.__renderMs = [], window.__perf.reset(), 'reset'`
  );
  const sseFile = path.join(OUT_DIR, PREFIX + 'rendercost-sse.json');
  execSync(
    `node "${path.join(ROOT, 'scripts', 'perf-measure.js')}" sse --port ${APP_PORT} --duration ${DURATION} --out "${sseFile}"`,
    { stdio: 'inherit' }
  );
  // small drain: let the last SSE-triggered renders land
  await new Promise((r) => setTimeout(r, 1500));
  const arr = await evaluate(
    source === '__kkPerf' ? `(window.__kkPerf.renders || []).map((r) => r.ms)` : `window.__renderMs || []`
  );
  const sse = JSON.parse(fs.readFileSync(sseFile, 'utf8')).sse;
  const s = [...arr].sort((a, b) => a - b);
  const pct = (p) => (s.length ? +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(2) : null);
  const out = {
    windowS: DURATION,
    instrumentedBy: source,
    cardsOnBoard: cards,
    sseEvents: sse.sseEvents,
    taskEvents: sse.taskEvents,
    mutations: sse.mutations,
    renderCalls: arr.length,
    p50ms: pct(50),
    p95ms: pct(95),
    maxMs: s.length ? +s[s.length - 1].toFixed(2) : null,
    totalMs: +arr.reduce((a, b) => a + b, 0).toFixed(1),
    renderMsPerSseEvent: sse.sseEvents ? +(arr.reduce((a, b) => a + b, 0) / sse.sseEvents).toFixed(2) : null,
    note: source === '__kkPerf'
      ? 'native __kkPerf.renders: only real render passes recorded (fingerprint-skips excluded); SSE frames are 250ms per-id coalesced'
      : 'includes early-return (fingerprint-skip) calls; renderCalls may differ from sseEvents (initial load, non-task events, coalescing)',
  };
  console.log(JSON.stringify(out, null, 2));
  writeOut('browser-rendercost.json', out);
  ws.close();
}

// Warm-reload page-load timing: 3 cache-warm navigations, median of
// domContentLoaded / load / LCP from PerformanceNavigationTiming.
async function warmLoad() {
  const { ws, send, evaluate } = await connect();
  await send('Page.enable');
  const runs = [];
  for (let i = 0; i < 3; i++) {
    await send('Page.navigate', { url: APP_URL });
    // wait for load event to complete
    for (let k = 0; k < 100; k++) {
      await new Promise((r) => setTimeout(r, 200));
      const done = await evaluate(`performance.timing && performance.timing.loadEventEnd > 0`).catch(() => false);
      if (done) break;
    }
    await waitForBoard(evaluate);
    // let LCP settle (board render happens after the initial fetch)
    await new Promise((r) => setTimeout(r, 1500));
    const m = await evaluate(`(async () => {
      const n = performance.getEntriesByType('navigation')[0];
      if (!n) return null;
      const lcpMs = await new Promise((res) => {
        let v = null;
        try {
          new PerformanceObserver((list) => {
            const e = list.getEntries();
            if (e.length) v = +e[e.length - 1].startTime.toFixed(1);
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (e) {}
        setTimeout(() => res(v), 1000);
      });
      return {
        ttfbMs: +(n.responseStart - n.startTime).toFixed(1),
        responseEndMs: +(n.responseEnd - n.startTime).toFixed(1),
        domContentLoadedMs: +(n.domContentLoadedEventEnd - n.startTime).toFixed(1),
        loadMs: +(n.loadEventEnd - n.startTime).toFixed(1),
        lcpMs,
      };
    })()`);
    runs.push(m);
  }
  const med = (key) => {
    const v = runs.map((r) => r && r[key]).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const out = {
    runs,
    median: {
      ttfbMs: med('ttfbMs'),
      responseEndMs: med('responseEndMs'),
      domContentLoadedMs: med('domContentLoadedMs'),
      loadMs: med('loadMs'),
      lcpMs: med('lcpMs'),
    },
    note: 'cache-warm reloads (same profile, revalidated static assets); headless Chrome',
  };
  console.log(JSON.stringify(out, null, 2));
  writeOut('browser-warmload.json', out);
  ws.close();
}

async function kill() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${list[0].id}`).catch(() => {});
  } catch {}
  execSync(`pkill -f "user-data-dir=${PROFILE}" || true`);
  console.log('chrome stopped');
}

(async () => {
  if (CMD === 'launch') await launch();
  else if (CMD === 'churn-window') await churnWindow();
  else if (CMD === 'drawer') await drawer(args[1]);
  else if (CMD === 'filter') await filterCost();
  else if (CMD === 'drag') await drag();
  else if (CMD === 'rendercost') await renderCost();
  else if (CMD === 'warmload') await warmLoad();
  else if (CMD === 'soak') await soak();
  else if (CMD === 'kill') await kill();
  else throw new Error('unknown command ' + CMD);
})().catch((e) => {
  console.error('perf-browser failed:', e.message);
  process.exit(1);
});
