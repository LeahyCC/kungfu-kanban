const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { discoverSkills, discoverAgents, discoverRepos, defaultReposDir } = require('./lib/discovery');
const os = require('os');
const { state, save, saveSettings, flush, getTask, readTranscript, clearTranscript, sweepArchive, readArchive, nextRev } = require('./lib/store');
const runner = require('./lib/runner');
const manager = require('./lib/manager');
const auth = require('./lib/auth');
const importer = require('./lib/importer');
const prwatch = require('./lib/prwatch');
const cooldown = require('./lib/cooldown');
const offline = require('./lib/offline');
const models = require('./lib/models');
const depsLib = require('./lib/deps');
const errlog = require('./lib/errlog');
const bus = require('./lib/bus');
const prflow = require('./lib/prflow');
const singleton = require('./lib/singleton');
const ptylib = require('./lib/pty');

// Before anything arms a timer or a watcher: refuse to be the second
// automation loop on this board. See lib/singleton.js for the six-day orphan
// that made this necessary.
const heldBy = singleton.claim();
if (heldBy) {
  console.error(
    `kungfu-kanban is already running against this data dir (pid ${heldBy}).\n` +
    `Refusing to start a second automation loop — it would double-import the inbox,\n` +
    `double-launch cards, and log its own failures to the real error tracker.\n` +
    `For a scratch server:  KFK_DATA_DIR=$(mktemp -d) KFK_TEST=1 PORT=<free> node server.js`
  );
  process.exit(1);
}

const PORT = process.env.PORT || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
app.use(express.json({ limit: '1mb' }));
auth.install(app); // token gate (only active when a token is configured) — must precede static

// --- gzip: stream-compress (never buffer) text-ish GET responses >= 1 KB
// when the client accepts it. /api/events is excluded — SSE must never be
// buffered or compressed. Content-Length is known for static/res.json, so
// known-small responses stay identity but still get Vary.
const zlib = require('zlib');
const GZIP_TYPES = /^(text\/html|text\/css|application\/javascript|application\/json|image\/svg\+xml)\b/;
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path === '/api/events') return next();
  if (!/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) return next();
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  let gz = null;
  let decided = false;
  const decide = () => {
    if (decided) return;
    decided = true;
    if (!GZIP_TYPES.test(String(res.getHeader('Content-Type') || ''))) return;
    res.vary('Accept-Encoding'); // caches must never mix gzip/identity bodies
    const len = Number(res.getHeader('Content-Length'));
    if (len && len < 1024) return; // known-small: gzip overhead isn't worth it
    gz = zlib.createGzip();
    res.removeHeader('Content-Length');
    res.setHeader('Content-Encoding', 'gzip');
    gz.on('data', (chunk) => write(chunk));
  };
  res.write = (chunk, enc, cb) => {
    decide();
    if (!gz) return write(chunk, enc, cb);
    gz.write(typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk, cb);
    return true;
  };
  res.end = (chunk, enc, cb) => {
    if (typeof chunk === 'function') { cb = chunk; chunk = null; enc = undefined; }
    else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    decide();
    if (!gz) return end(chunk, enc, cb);
    // Wait for the gz readable side to fully drain ('end') — the writable
    // finish callback can fire before buffered output is emitted, and ending
    // the socket then would truncate the body.
    gz.once('end', () => end(cb));
    gz.end(typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk);
  };
  next();
});

// xterm.js for the built-in terminal, served straight out of node_modules so
// no build step and no vendored blob in git. Loaded on demand by js/term.js —
// the board's first paint never pays for it.
for (const [route, pkg] of [
  ['/vendor/xterm', '@xterm/xterm/lib'],
  ['/vendor/xterm-css', '@xterm/xterm/css'],
  ['/vendor/xterm-fit', '@xterm/addon-fit/lib'],
]) {
  app.use(route, express.static(path.join(__dirname, 'node_modules', pkg), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'max-age=86400'),
  }));
}

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      // Text assets: revalidate every load (dev serves fresh from disk; the
      // ETag makes an unchanged file a cheap 304). Images/icons are
      // content-stable, so let them cache for a day.
      if (/\.(html|js|css|webmanifest)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'max-age=86400, immutable');
      }
    },
  })
);

// --- Server-sent events ---
const sseClients = new Set();

// Writes one framed message to one client. A slow client (write() -> false)
// is marked congested: task frames buffer last-write-wins per task id (at
// most one pending frame per id), non-task frames drop, and normal writes
// resume on 'drain'. A client that never drains within ~30s is destroyed —
// its EventSource auto-reconnects and refetches the board (that path already
// exists client-side).
function sseSend(res, data, taskId) {
  if (res.destroyed) return void sseClients.delete(res);
  if (res._congested) {
    if (taskId) res._pending.set(taskId, data);
    return;
  }
  if (res.write(data)) return;
  res._congested = true;
  res._pending = new Map();
  res._drainTimer = setTimeout(() => {
    sseClients.delete(res);
    res.destroy();
  }, 30_000);
  res.socket.once('drain', () => {
    clearTimeout(res._drainTimer);
    const pending = [...res._pending];
    res._pending.clear();
    res._congested = false;
    for (const [id, frame] of pending) sseSend(res, frame, id);
  });
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => {
    clearTimeout(res._drainTimer);
    sseClients.delete(res);
  });
});

setInterval(() => {
  for (const res of sseClients) sseSend(res, ': ping\n\n', null);
}, 25_000);

// Slim SSE task projection: the heavy text fields never ride the SSE channel.
// Clients merge task frames shallowly by id; the drawer fetches the full task
// on open (GET /api/tasks/:id). Create/PATCH HTTP responses stay full.
// `v` is stamped here, BEFORE serialization — the single chokepoint every
// broadcast mutation passes through (save-only paths use store.touch()).
const SLIM_OMIT = ['prompt', 'resultText', 'acceptanceCriteria'];
const COALESCE_MS = 250; // trailing-edge, last-write-wins per task id
const coalesced = new Map(); // taskId -> msg
let coalesceTimer = null;

function emitSse(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  // A congested client buffers last-write-wins per id and drops keyless frames.
  // Both task and deleted frames must carry the id so a delete survives
  // backpressure (a delete is terminal, so keying it under the same id lets it
  // overwrite any still-pending task frame — never the other way around).
  const taskId =
    msg && msg.type === 'task' && msg.task ? msg.task.id
    : msg && msg.type === 'deleted' ? msg.taskId
    : null;
  for (const res of sseClients) sseSend(res, data, taskId);
}

function flushCoalesced() {
  coalesceTimer = null;
  const frames = [...coalesced.values()];
  coalesced.clear();
  for (const msg of frames) emitSse(msg);
}

function broadcast(msg) {
  if (msg && msg.type === 'task' && msg.task) {
    const slim = { ...msg.task };
    for (const f of SLIM_OMIT) delete slim[f];
    slim.v = nextRev();
    // The flag rides the TASK, not the frame: the client's mergeTaskPayload
    // reads incoming.full to decide shallow-merge (keep omitted heavy fields)
    // vs wholesale-replace. On the frame it was invisible to the client, so
    // every slim frame wiped prompt/resultText/acceptanceCriteria from state.
    slim.full = false;
    coalesced.set(slim.id, { ...msg, task: slim });
    if (!coalesceTimer) coalesceTimer = setTimeout(flushCoalesced, COALESCE_MS);
    return;
  }
  // A removal changes the board — advance the revision so GET /api/tasks?v=
  // won't answer 304 to a client that missed this frame (leaving a ghost card
  // no refetch could clear).
  if (msg && msg.type === 'deleted') nextRev();
  // A delete must never be followed by a stale task frame for the same id —
  // flush whatever is pending for it first, then let the delete through.
  if (msg && msg.type === 'deleted' && coalesced.has(msg.taskId)) {
    emitSse(coalesced.get(msg.taskId));
    coalesced.delete(msg.taskId);
  }
  emitSse(msg); // small/control frames pass through immediately
}
bus.subscribe(broadcast);
prwatch.backfillMergedAt();
prwatch.applyInterval();
setTimeout(() => prwatch.sweep(), 30_000); // first pass shortly after boot
runner.setOnFinish((task) => {
  // A card that just opened/updated a PR: sweep once after CI has had a couple
  // of minutes, so fast failures (branch guards fail in seconds) badge the
  // card long before the next interval sweep.
  if (task.prUrl && !task.error) setTimeout(() => prwatch.sweep(), 120_000);
  manager.pruneSuggestions();
  if (manager.config().triggers.onFinish) {
    manager.invoke(`task finished and awaits review: "${task.title}" (id ${task.id})`);
  }
});
manager.applyInterval();

// --- Archive sweep: move old "done" cards to data/archive.jsonl daily ---
function runArchiveSweep() {
  const archived = sweepArchive();
  for (const t of archived) broadcast({ type: 'deleted', taskId: t.id });
  importer.sweepImported();
}
runArchiveSweep();
setInterval(runArchiveSweep, 24 * 60 * 60 * 1000);

// --- Config: models, efforts, skills, agents ---
const MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];

function reposDir() {
  // Never hardcode one person's folder layout — auto-scan common dev locations
  // when the user hasn't configured a directory (they set it in ⚙ Settings).
  return state.settings.reposDir || defaultReposDir();
}

app.get('/api/config', (req, res) => {
  res.json({
    models: MODELS,
    efforts: EFFORTS,
    permissionModes: PERMISSION_MODES,
    skills: discoverSkills(),
    agents: discoverAgents(),
    repos: discoverRepos(reposDir()),
    settings: { ...state.settings, reposDir: reposDir() },
    cooldownUntil: cooldown.active() ? state.settings.cooldownUntil : 0,
    offline: offline.active(),
    cliLoggedOut: require('./lib/authgate').active(),
    modelBlocks: models.blocks(),
    authGate: !!auth.getToken(), // the UI shows Sign out only when a gate exists
  });
});

app.put('/api/settings', (req, res) => {
  const { maxConcurrent, defaultCwd, archiveDays, ntfyTopic, notifyMac, keepAwake, reposDir: rd, prWatchMin, prWatchAutoFix, maxRunMinutes } = req.body || {};
  // an empty string clears the setting (falls back to the default scan dir)
  if (typeof rd === 'string') {
    if (rd.trim()) state.settings.reposDir = rd.trim();
    else delete state.settings.reposDir;
  }
  if (Number.isInteger(prWatchMin) && prWatchMin >= 0 && prWatchMin <= 120) {
    state.settings.prWatchMin = prWatchMin;
    prwatch.applyInterval();
  }
  if (typeof prWatchAutoFix === 'boolean') state.settings.prWatchAutoFix = prWatchAutoFix;
  if (typeof req.body.prWatchAutoFixCi === 'boolean') state.settings.prWatchAutoFixCi = req.body.prWatchAutoFixCi;
  // Turning the built-in terminal off also ends the shells it already opened —
  // a switch that leaves live sessions running isn't a switch.
  const { terminal } = req.body || {};
  if (typeof terminal === 'boolean') {
    state.settings.terminal = terminal;
    if (!terminal) ptylib.killAll();
  }
  const { usageBudgetM } = req.body || {};
  if (typeof usageBudgetM === 'number' && usageBudgetM >= 0 && usageBudgetM <= 1000) {
    state.settings.usageBudgetTokens = Math.round(usageBudgetM * 1_000_000);
  }
  if (Number.isInteger(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 8) {
    state.settings.maxConcurrent = maxConcurrent;
  }
  if (Number.isInteger(maxRunMinutes) && maxRunMinutes >= 0 && maxRunMinutes <= 1440) {
    state.settings.maxRunMinutes = maxRunMinutes;
  }
  if (typeof defaultCwd === 'string') state.settings.defaultCwd = defaultCwd.trim(); // empty clears it
  const { defaultPermissionMode } = req.body || {};
  if (typeof defaultPermissionMode === 'string') {
    if (PERMISSION_MODES.includes(defaultPermissionMode)) state.settings.defaultPermissionMode = defaultPermissionMode;
    else if (!defaultPermissionMode) delete state.settings.defaultPermissionMode; // empty resets to acceptEdits
  }
  // Board-wide defaults a card's 'default' model/effort resolves to at launch.
  const { defaultModel, defaultEffort } = req.body || {};
  if (typeof defaultModel === 'string') {
    if (MODELS.includes(defaultModel) && defaultModel !== 'default') state.settings.defaultModel = defaultModel;
    else delete state.settings.defaultModel; // 'default' or empty = let the CLI pick
  }
  if (typeof defaultEffort === 'string') {
    if (EFFORTS.includes(defaultEffort) && defaultEffort !== 'default') state.settings.defaultEffort = defaultEffort;
    else delete state.settings.defaultEffort;
  }
  if (Number.isInteger(archiveDays) && archiveDays >= 0 && archiveDays <= 365) {
    state.settings.archiveDays = archiveDays;
  }
  if (typeof ntfyTopic === 'string') state.settings.ntfyTopic = ntfyTopic.trim();
  if (typeof notifyMac === 'boolean') state.settings.notifyMac = notifyMac;
  if (typeof keepAwake === 'boolean') {
    state.settings.keepAwake = keepAwake;
    // Drop any live timed assertion; per-agent ones die with their process.
    if (!keepAwake) require('./lib/awake').clear();
  }
  saveSettings();
  runner.pumpQueue();
  res.json(state.settings);
});

// --- Markdown import: paste/upload via API, or drop .md files in data/inbox ---
function triageImported(created, source) {
  if (manager.config().triggers.onNewCard) {
    manager.invoke(
      `${created.length} card(s) imported from markdown (${source}) — triage them (routing, priority); do not run them unless trivially safe`
    );
  }
}

app.post('/api/import', (req, res) => {
  const md = (req.body && req.body.markdown) || '';
  if (!md.trim()) return res.status(400).json({ error: 'empty markdown' });
  const created = importer.importMarkdown(md);
  if (created.length) triageImported(created, 'pasted');
  res.json({ created: created.length, ids: created.map((t) => t.id) });
});

// A cooldown can outlive its cause — a new CLI login or an upgraded plan —
// and the only remedy used to be editing settings.json around a restart
// (which the shutdown flush clobbers by rewriting in-memory state over the
// file). Clearing is explicit human intent, so it also pumps the queue right
// away instead of waiting for the minute sweep. The confirm lives client-side:
// clearing while the limit still applies just re-trips it on the next launch.
app.post('/api/cooldown/clear', (req, res) => {
  cooldown.clear();
  runner.pumpQueue();
  res.json({ ok: true });
});

importer.watchInbox(triageImported);

// Draft an import document from natural language (runs on the subscription).
// {request} for a fresh draft (+ optional {repoPath, explore} to ground it in
// the actual code); {refine, sessionId} to revise the previous draft in place.
app.post('/api/import/draft', async (req, res) => {
  const b = req.body || {};
  if (cooldown.active()) return res.status(503).json({ error: 'subscription is cooling down — try after the timer' });
  try {
    let op;
    if (b.refine && b.sessionId) {
      op = importer.refine(String(b.sessionId), String(b.refine).slice(0, 5000));
    } else {
      const request = (b.request || '').trim();
      if (!request) return res.status(400).json({ error: 'empty request' });
      const repos = discoverRepos(reposDir());
      const repoPath = repos.some((r) => r.path === b.repoPath) ? b.repoPath : null;
      if (b.explore && !repoPath) return res.status(400).json({ error: 'explore needs a repo — pick one first' });
      op = importer.draft(request, {
        repos,
        defaultCwd: state.settings.defaultCwd,
        repoPath,
        explore: !!b.explore && !!repoPath,
      });
    }
    killOnDisconnect(res, op); // cancelled in the UI → stop the claude process
    res.json(await op.promise);
  } catch (e) {
    if (!res.writableEnded) res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

// Kill an agent call when the CLIENT actually goes away, so a cancelled UI
// doesn't burn subscription usage. This must hang off the RESPONSE, not the
// request: `req`'s 'close' fires as soon as the body has been read (~16ms in,
// long before the work finishes), so the old req-based guard SIGTERM'd the
// agent it had just spawned. `writableFinished` separates "we answered" from
// "the connection dropped".
function killOnDisconnect(res, op) {
  res.on('close', () => { if (!res.writableFinished) op.kill(); });
}

// Sharpen a single prompt in place — returns better text, touches nothing.
app.post('/api/prompt/improve', async (req, res) => {
  const b = req.body || {};
  if (cooldown.active()) return res.status(503).json({ error: 'subscription is cooling down — try after the timer' });
  const text = (b.text || '').trim();
  if (!text) return res.status(400).json({ error: 'nothing to improve' });
  try {
    const repos = discoverRepos(reposDir());
    const repoPath = repos.some((r) => r.path === b.repoPath) ? b.repoPath : null;
    const op = importer.improvePrompt(text.slice(0, 5000), { repoPath });
    killOnDisconnect(res, op);
    const out = await op.promise;
    res.json({ text: out.markdown });
  } catch (e) {
    if (!res.writableEnded) res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

// Parse preview: what would this markdown create, and does anything collide?
app.post('/api/import/preview', (req, res) => {
  const cards = importer.parseMarkdown(((req.body || {}).markdown) || '');
  const existing = new Set(state.tasks.map((t) => t.title.trim().toLowerCase()));
  res.json({
    cards: cards.map((c) => ({ title: c.title, model: c.model || 'default', priority: c.priority || 0 })),
    dupes: cards.filter((c) => existing.has(c.title.trim().toLowerCase())).map((c) => c.title),
  });
});

// Open GitHub issues of a repo → an import document (review before importing).
app.post('/api/import/issues', (req, res) => {
  const repos = discoverRepos(reposDir());
  const repoPath = repos.some((r) => r.path === (req.body || {}).repoPath) ? req.body.repoPath : null;
  if (!repoPath) return res.status(400).json({ error: 'pick a repo first' });
  require('child_process').execFile(
    'gh', ['issue', 'list', '--json', 'number,title,body,labels', '--limit', '50'],
    { cwd: repoPath, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => {
      if (err) return res.status(500).json({ error: String(err.message).slice(0, 200) });
      let issues;
      try { issues = JSON.parse(stdout); } catch { return res.status(500).json({ error: 'unparsable gh output' }); }
      if (!issues.length) return res.json({ markdown: '', count: 0 });
      const md = [
        '---', `cwd: ${repoPath}`, 'worktree: true', 'openPr: true', '---', '',
        ...issues.map((i) => {
          const urgent = (i.labels || []).some((l) => /bug|urgent|p0|p1/i.test(l.name));
          return [
            `## ${i.title}`,
            `issue: ${i.number}`,
            urgent ? 'priority: 2' : '',
            (i.body || i.title).trim().slice(0, 3000).replace(/^#{1,2}(\s+\S)/gm, '###$1'),
            '',
          ].filter(Boolean).join('\n');
        }),
      ].join('\n');
      res.json({ markdown: md, count: issues.length });
    }
  );
});

// Manual PR-watch pass (also runs on an interval).
app.post('/api/prwatch/sweep', (req, res) => {
  prwatch.sweep();
  res.json({ ok: true });
});

// --- Error tracker: auto-logged operational errors & blocks ---
app.get('/api/errors', (req, res) => {
  res.json({ errors: errlog.list(), open: errlog.openCount() });
});

app.post('/api/errors/resolve-all', (req, res) => {
  res.json({ ok: true, resolved: errlog.resolveAll('human') });
});

app.post('/api/errors/:id/resolve', (req, res) => {
  const e = errlog.resolve(req.params.id, 'human');
  if (!e) return res.status(404).json({ error: 'not found (already resolved?)' });
  res.json({ ok: true });
});

// Board version + update check (git-based; fork-friendly).
const version = require('./lib/version');
app.get('/api/version', async (req, res) => res.json(await version.check()));

// Pull the latest board code and restart. Blocked while agents run — the
// restart would orphan their processes. Under launchd, exiting is restarting;
// under a bare `npm start` the process just stops (the UI says so).
app.post('/api/system/update-board', async (req, res) => {
  if (state.tasks.some((t) => t.status === 'running' || t.status === 'stopping')) {
    return res.status(409).json({ error: 'cards are running — update when the board is idle' });
  }
  try {
    const r = await version.update();
    res.json({ ok: true, ...r, restarting: true });
    setTimeout(() => process.exit(0), 800); // launchd KeepAlive brings us back
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

// The board's Claude Code skills (kungfu-todo, ponytail): check + one-click
// install/update.
const skill = require('./lib/skill');
// Auto-install/refresh at boot — kungfu-todo bakes in this install's absolute
// paths and port, so a moved clone or changed PORT re-syncs on next start.
// Skipped under KFK_TEST: a scratch/test-spawned server's absolute paths and
// random port must never overwrite the real installed skill in ~/.claude/skills.
if (!process.env.KFK_TEST) {
  try {
    const stale = skill.status().filter((s) => !s.current);
    if (stale.length) {
      skill.install();
      console.log(`skills installed/refreshed: ${stale.map((s) => s.name).join(', ')}`);
    }
  } catch (e) {
    console.warn('skill auto-install failed:', String(e.message || e));
  }
}
app.get('/api/skill', (req, res) => res.json({ skills: skill.status() }));
app.post('/api/skill/install', (req, res) => {
  try {
    res.json({ ok: true, skills: skill.install() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
});

// Rolling 5-hour usage across all local Claude Code activity. Cached 2 min.
app.get('/api/usage', async (req, res) => {
  const usage = await require('./lib/usage').scan();
  // active() doubles as the refresh trigger whenever a tab polls
  res.json({ ...usage, budgetTokens: state.settings.usageBudgetTokens || 0, blocked: require('./lib/budget').active() });
});

// Update the Claude Code CLI in place. `claude update` knows its own install
// method — but a Homebrew-managed install refuses to self-update and answers
// "To update, run: brew upgrade <formula>", so we run that exact command for
// the user (the button used to just display it). Running agents keep their
// already-loaded binary; new runs get the new version.
app.post('/api/system/update-claude', (req, res) => {
  execFile('claude', ['update'], { timeout: 300_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    healthCache = { at: 0, data: null }; // version may have changed — recheck
    const all = `${stdout || ''}\n${stderr || ''}`;
    const tail = (s) => s.trim().split('\n').filter(Boolean).slice(-3).join('\n');
    // Formula name comes from claude's own output but is shape-checked, and
    // execFile takes an arg array — nothing shell-interpolates. launchd's PATH
    // usually lacks brew, so probe the standard install locations first.
    const brewCmd = all.match(/brew (upgrade|install) ([A-Za-z0-9@._/-]+)/);
    if (brewCmd) {
      const fs = require('fs');
      const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => fs.existsSync(p)) || 'brew';
      // Force brew's tap auto-refresh: with a stale index brew answers
      // "already installed" while claude's own checker sees a newer release.
      const brewEnv = { ...process.env, HOMEBREW_AUTO_UPDATE_SECS: '1' };
      return execFile(brew, [brewCmd[1], brewCmd[2]], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, env: brewEnv }, (bErr, bOut, bErrOut) => {
        healthCache = { at: 0, data: null };
        if (bErr) return res.status(500).json({ error: (tail(`${bOut || ''}\n${bErrOut || ''}`) || bErr.message).slice(0, 300) });
        execFile('claude', ['--version'], { timeout: 15_000 }, (vErr, vOut) => {
          const ver = (vOut || '').trim().split('\n')[0];
          res.json({ ok: true, output: `brew ${brewCmd[1]} ${brewCmd[2]} ✓${ver ? ` — now on ${ver}` : ''}`.slice(0, 300) });
        });
      });
    }
    const out = tail(all);
    if (err) return res.status(500).json({ error: (out || err.message).slice(0, 300) });
    res.json({ ok: true, output: out.slice(0, 300) });
  });
});

// --- Built-in terminal -----------------------------------------------------
// A real shell on a real pty (lib/pty.js), reachable from whatever device the
// board is open on. Sessions live server-side, so a reload reattaches instead
// of restarting. Output rides SSE base64-framed (terminal bytes are binary and
// full of newlines — neither survives a raw SSE data line); keystrokes come
// back over POST, which on loopback/tailnet is well under a frame of latency.
function termEnabled() {
  return state.settings.terminal !== false;
}
function termGate(req, res, next) {
  if (!termEnabled()) return res.status(403).json({ error: 'the built-in terminal is off — enable it in ⚙ Settings' });
  next();
}

app.get('/api/term', termGate, (req, res) => res.json({ sessions: ptylib.list() }));

app.post('/api/term', termGate, (req, res) => {
  const b = req.body || {};
  const r = ptylib.create({
    cwd: b.cwd || state.settings.defaultCwd,
    cols: b.cols,
    rows: b.rows,
    label: b.label,
  });
  if (r.error) return res.status(400).json(r);
  res.json(r.session);
});

// A card's own shell. Opens where the agent actually worked — the git worktree
// it ran in when the card used one, not the parent repo — so `git diff`, the
// test suite, and `claude -r <session>` all land in the right tree. One live
// session per card: reopening the drawer reattaches instead of piling up shells.
app.post('/api/tasks/:id/term', termGate, async (req, res) => {
  const t = getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'no such card' });
  const existing = ptylib.forTask(t.id);
  if (existing) return res.json({ ...existing, reattached: true });

  let dir = t.cwd;
  if (t.worktree) {
    // Same lookup the PR flow uses, so we agree with it about where the card's
    // work lives. A missing worktree (never ran, already cleaned up) falls back
    // to the repo rather than failing to open a shell at all.
    try {
      const wt = await prflow.findWorktree(t.cwd, `kanban-${t.id.slice(0, 8)}`);
      if (wt && wt.path) dir = wt.path;
    } catch {}
  }
  const r = ptylib.create({
    cwd: dir,
    cols: (req.body || {}).cols,
    rows: (req.body || {}).rows,
    label: t.title,
    taskId: t.id,
  });
  if (r.error) return res.status(400).json(r);
  res.json(r.session);
});

app.get('/api/term/:id/stream', termGate, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Coalesce per tick: a chatty build emits thousands of small writes, and one
  // SSE frame each would spend more time framing than rendering.
  let pending = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!pending.length) return;
    const chunk = Buffer.concat(pending);
    pending = [];
    if (!res.destroyed) res.write(`data: ${chunk.toString('base64')}\n\n`);
  };
  const handle = ptylib.attach(req.params.id, (chunk) => {
    pending.push(chunk);
    if (!timer) timer = setTimeout(flush, 16);
  });
  if (!handle) {
    res.write('event: gone\ndata: {}\n\n');
    return res.end();
  }
  if (handle.backlog.length) res.write(`data: ${handle.backlog.toString('base64')}\n\n`);
  const ping = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clearTimeout(timer);
    handle.detach();
  });
});

app.post('/api/term/:id/input', termGate, (req, res) => {
  const data = (req.body || {}).data;
  if (typeof data !== 'string') return res.status(400).json({ error: 'no data' });
  if (!ptylib.write(req.params.id, Buffer.from(data, 'base64'))) {
    return res.status(410).json({ error: 'session is gone' });
  }
  res.json({ ok: true });
});

app.post('/api/term/:id/resize', termGate, (req, res) => {
  const b = req.body || {};
  if (!ptylib.resize(req.params.id, b.cols, b.rows)) return res.status(410).json({ error: 'session is gone' });
  res.json({ ok: true });
});

app.delete('/api/term/:id', termGate, (req, res) => res.json({ ok: ptylib.kill(req.params.id) }));

// System health: is the claude CLI reachable, is gh authed? Cached 5 min.
let healthCache = { at: 0, data: null };
app.get('/api/health', async (req, res) => {
  if (healthCache.data && Date.now() - healthCache.at < 5 * 60_000) return res.json(healthCache.data);
  const check = (cmd, args) =>
    new Promise((r) => execFile(cmd, args, { timeout: 10_000 }, (err, stdout) =>
      r({ ok: !err, out: (stdout || '').trim().split('\n')[0].slice(0, 60) })));
  const [claude, gh] = await Promise.all([
    check('claude', ['--version']),
    check('gh', ['auth', 'status']),
  ]);
  healthCache = { at: Date.now(), data: { claude, gh } };
  res.json(healthCache.data);
});

// Merge or close a card's PR right from the board (gh does the work).
app.post('/api/tasks/:id/pr', (req, res) => {
  const task = getTask(req.params.id);
  if (!task || !task.prUrl) return res.status(404).json({ error: 'no PR on this card' });
  const action = (req.body || {}).action;
  if (!['merge', 'close'].includes(action)) return res.status(400).json({ error: 'action must be merge|close' });
  if (action === 'merge') {
    return prflow.mergePr(task).then((result) => {
      if (!result.ok) return res.status(500).json({ error: result.error });
      res.json({ ok: true });
    });
  }
  execFile('gh', ['pr', 'close', task.prUrl], { timeout: 60_000, cwd: task.cwd }, (err, stdout, stderr) => {
    const note = (kind, text) => {
      require('./lib/store').appendTranscript(task.id, { kind, text });
      broadcast({ type: 'output', taskId: task.id, entry: { kind, text } });
    };
    if (err) {
      const msg = (stderr || err.message || '').trim().slice(0, 300);
      note('error', `PR close failed — ${msg}`);
      return res.status(500).json({ error: msg });
    }
    task.prClosedNoted = true;
    note('pr', 'PR closed from the board (not merged)');
    save();
    broadcast({ type: 'task', task });
    res.json({ ok: true });
  });
});

// Fire both notification channels on demand, for wiring up phones.
app.post('/api/notify/test', (req, res) => {
  require('./lib/notify').notify('Kungfu Kanban — test 🥋', 'If you can read this, notifications work.');
  res.json({ ok: true, topic: state.settings.ntfyTopic || null });
});

// --- Tasks ---
const TASK_FIELDS = [
  'title', 'prompt', 'cwd', 'model', 'effort', 'permissionMode',
  'skills', 'skillsAuto', 'agent', 'worktree', 'openPr', 'prBaseBranch', 'status', 'priority', 'acceptanceCriteria',
  'schedule', 'issueNumber', 'group',
  'prUrl', // repair hatch: lets a manually-created PR be attached to its card
  'permissionBlocked', // acknowledge-only: the UI may clear a block (null), never set one
];
const STATUSES = ['backlog', 'queued', 'running', 'stopping', 'review', 'done'];

const { parseSchedule, scheduleDue } = require('./lib/schedule');

function makeTask(b, createdBy = 'user') {
  return {
    id: crypto.randomUUID(),
    title: (b.title || 'Untitled task').slice(0, 200),
    prompt: b.prompt || '',
    cwd: b.cwd || state.settings.defaultCwd,
    model: b.model || 'default',
    effort: b.effort || 'default',
    permissionMode: b.permissionMode || state.settings.defaultPermissionMode || 'acceptEdits',
    skills: Array.isArray(b.skills) ? b.skills : [],
    skillsAuto: !!b.skillsAuto,
    agent: b.agent || null,
    worktree: !!b.worktree,
    openPr: !!b.openPr,
    prBaseBranch: typeof b.prBaseBranch === 'string' && b.prBaseBranch.trim() ? b.prBaseBranch.trim() : null,
    priority: Number.isInteger(b.priority) ? b.priority : 0,
    acceptanceCriteria: b.acceptanceCriteria || '',
    group: typeof b.group === 'string' && b.group.trim() ? b.group.trim().slice(0, 60) : null,
    deps: depsLib.sanitize(b.deps, null),
    schedule: parseSchedule(b.schedule),
    issueNumber: Number.isInteger(b.issueNumber) ? b.issueNumber : null,
    status: 'backlog',
    createdAt: new Date().toISOString(),
    createdBy,
    retries: 0,
    sessionId: null,
    error: null,
    resultText: null,
    stats: null,
  };
}

// Conditional refetch: a client already holding this board version gets a
// cheap empty 304 instead of the full payload.
app.get('/api/tasks', (req, res) => {
  if (req.query.v !== undefined && Number(req.query.v) === state.seq) return res.status(304).end();
  res.setHeader('X-Board-Version', String(state.seq));
  res.json(state.tasks);
});

// Full single task — SSE task frames are slim projections (no prompt /
// resultText / acceptanceCriteria), so the drawer fetches the full record
// from here on open.
app.get('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(task);
});

app.post('/api/tasks', (req, res) => {
  const task = makeTask(req.body || {});
  state.tasks.unshift(task);
  save();
  broadcast({ type: 'task', task });
  if (manager.config().triggers.onNewCard) {
    manager.invoke(`new card added to backlog by human: "${task.title}" (id ${task.id}) — triage it (routing, priority); do not run it unless it is trivially safe`);
  }
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status === 'running' || task.status === 'stopping') {
    // Only allow no-op / status moves are blocked while running
    return res.status(409).json({ error: 'task is running' });
  }
  if ('status' in req.body && (req.body.status === 'running' || req.body.status === 'stopping')) {
    return res.status(400).json({ error: 'status cannot be set directly to running/stopping' });
  }
  if ('deps' in req.body) {
    const clean = depsLib.sanitize(req.body.deps, task.id);
    if (depsLib.wouldCycle(task.id, clean)) {
      return res.status(400).json({ error: 'dependency cycle — a card cannot (transitively) wait on itself' });
    }
    task.deps = clean;
    delete task.depsUnresolved;
  }
  for (const f of TASK_FIELDS) {
    if (!(f in req.body)) continue;
    if (f === 'title') task.title = (req.body.title || 'Untitled task').slice(0, 200);
    else if (f === 'priority') task.priority = Number.isInteger(req.body.priority) ? req.body.priority : 0;
    else if (f === 'skills') task.skills = Array.isArray(req.body.skills) ? req.body.skills : [];
    else if (f === 'group') task.group = typeof req.body.group === 'string' && req.body.group.trim() ? req.body.group.trim().slice(0, 60) : null;
    else if (f === 'permissionBlocked') {
      if (!req.body.permissionBlocked) {
        task.permissionBlocked = null;
        if (/^Blocked on permission/.test(task.error || '')) task.error = null;
        require('./lib/errlog').resolveTask(task.id, ['permission']);
      }
    }
    else task[f] = req.body[f];
  }
  if ('schedule' in req.body) task.schedule = parseSchedule(req.body.schedule);
  if (!STATUSES.includes(task.status)) task.status = 'backlog';
  save();
  broadcast({ type: 'task', task });
  // Shipping a card (or loosening deps) can free queued dependents.
  if (task.status === 'done' || 'deps' in req.body) runner.pumpQueue();
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (runner.isRunning(task.id)) return res.status(409).json({ error: 'stop it first' });
  state.tasks = state.tasks.filter((t) => t.id !== task.id);
  save();
  clearTranscript(task.id);
  errlog.resolveTask(task.id); // a deleted card's open errors die with it
  broadcast({ type: 'deleted', taskId: task.id });
  runner.pumpQueue(); // a deleted dep counts as met — free any waiting dependents
  res.json({ ok: true });
});

// Clear the Done column in one shot. Cards go where the daily sweep sends
// them — data/archive.jsonl — so "clear" stays browsable under Archive instead
// of being a 42-card delete you cannot take back.
app.post('/api/tasks/archive-done', (req, res) => {
  const archived = sweepArchive({ all: true });
  for (const t of archived) {
    errlog.resolveTask(t.id); // an archived card's open errors go with it
    broadcast({ type: 'deleted', taskId: t.id });
  }
  // an archived dep counts as met — free anything that was waiting on one
  if (archived.length) runner.pumpQueue();
  res.json({ ok: true, archived: archived.length });
});

app.get('/api/tasks/:id/transcript', (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(readTranscript(req.params.id));
});

// --- Archive browser: read-only over data/archive.jsonl ---
// ponytail: full-file read + 1000-row cap — offset paging if an archive ever outgrows it
const ARCHIVE_CAP = 1000;
app.get('/api/archive', (req, res) => {
  const all = readArchive();
  const stats = { total: all.length, tokensOut: 0, tokensIn: 0, costUsd: 0, perWeek: {}, perRepo: {} };
  for (const t of all) {
    const s = t.stats || {};
    stats.tokensOut += s.outputTokens || 0;
    stats.tokensIn += s.inputTokens || 0;
    stats.costUsd += s.costUsd || 0;
    const ts = Date.parse(t.finishedAt || t.createdAt || '');
    if (Number.isFinite(ts)) {
      const d = new Date(ts);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
      const wk = d.toISOString().slice(0, 10);
      stats.perWeek[wk] = (stats.perWeek[wk] || 0) + 1;
    }
    const repo = t.cwd ? path.basename(t.cwd) : '(none)';
    stats.perRepo[repo] = (stats.perRepo[repo] || 0) + 1;
  }
  const items = all.slice(-ARCHIVE_CAP).reverse().map((t) => {
    const slim = { ...t };
    for (const f of SLIM_OMIT) delete slim[f];
    return slim;
  });
  res.json({ items, total: all.length, stats });
});

app.get('/api/archive/:id', (req, res) => {
  const hit = readArchive().find((t) => t.id === req.params.id);
  if (!hit) return res.status(404).json({ error: 'not found' });
  res.json(hit);
});

app.post('/api/tasks/:id/run', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (runner.isRunning(task.id)) return res.status(409).json({ error: 'already running' });
  res.json(runner.startTask(task.id));
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const out = runner.stopTask(req.params.id);
  if (out.error) return res.status(409).json(out);
  res.json(out);
});

// Follow-up prompt: resume the card's session with extra instructions.
app.post('/api/tasks/:id/followup', (req, res) => {
  const msg = ((req.body && req.body.message) || '').trim();
  if (!msg) return res.status(400).json({ error: 'empty message' });
  const out = runner.followUp(req.params.id, msg);
  if (out.error) return res.status(409).json(out);
  res.json(out);
});

// --- Manager ---
app.get('/api/manager', (req, res) => res.json(manager.publicState()));

const MANAGER_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
const MANAGER_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const MANAGER_AUTONOMY = ['suggest', 'semi', 'auto'];
const MANAGER_PERM_CEILINGS = ['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'];

app.put('/api/manager/config', (req, res) => {
  const c = manager.config();
  const b = req.body || {};
  if ('enabled' in b) c.enabled = !!b.enabled;
  if ('model' in b && MANAGER_MODELS.includes(b.model)) c.model = b.model;
  if ('effort' in b && MANAGER_EFFORTS.includes(b.effort)) c.effort = b.effort;
  if ('autonomy' in b && MANAGER_AUTONOMY.includes(b.autonomy)) c.autonomy = b.autonomy;
  if ('stylePrompt' in b) c.stylePrompt = String(b.stylePrompt || '');
  if ('maxLaunchesPerHour' in b && Number.isInteger(b.maxLaunchesPerHour)) c.maxLaunchesPerHour = Math.max(0, b.maxLaunchesPerHour);
  if ('maxRetries' in b && Number.isInteger(b.maxRetries)) c.maxRetries = Math.max(0, b.maxRetries);
  if ('permissionCeiling' in b && MANAGER_PERM_CEILINGS.includes(b.permissionCeiling)) c.permissionCeiling = b.permissionCeiling;
  if (b.triggers) c.triggers = { ...c.triggers, ...b.triggers };
  // booleans only, and only for actions the ladder actually holds back — an
  // unknown key here would silently grant nothing, so drop it rather than store it
  if (b.autoActions) {
    for (const [k, v] of Object.entries(b.autoActions)) {
      if (k in c.autoActions) c.autoActions[k] = !!v;
    }
  }
  saveSettings();
  manager.applyInterval();
  res.json(c);
});

// Escape hatch for a misclicked trigger: kill the in-flight Sensei run.
app.post('/api/manager/stop', (req, res) => res.json(manager.stopCurrent()));

app.post('/api/manager/chat', (req, res) => {
  const msg = (req.body && req.body.message || '').trim();
  if (!msg) return res.status(400).json({ error: 'empty message' });
  manager.chat(msg);
  res.json({ ok: true });
});

app.post('/api/manager/suggestions/:sid', (req, res) => {
  res.json(manager.resolveSuggestion(req.params.sid, !!(req.body && req.body.approve)));
});

// Fresh starts: clear the chat and/or the activity log.
app.post('/api/manager/clear', (req, res) => {
  const b = req.body || {};
  if (b.chat) manager.clearChat();
  if (b.log) manager.clearLog();
  res.json({ ok: true });
});

// --- Scheduled cards ---
// Scheduled cards live in Backlog and never move columns themselves. Once a
// minute we check each for a due schedule; when due we clone it into a fresh
// one-shot card (no schedule of its own) and launch it via runner.startTask,
// which respects the maxConcurrent queue — the clone flows through the board
// like any other card while the original stays put in Backlog.
function checkSchedules() {
  const now = new Date();
  for (const task of state.tasks) {
    if (task.status !== 'backlog' || !task.schedule) continue;
    if (!scheduleDue(task, now)) continue;
    task.schedule.lastFired = now.toISOString();
    const clone = makeTask({ ...task, schedule: null }, 'schedule');
    state.tasks.unshift(clone);
    save();
    broadcast({ type: 'task', task });
    broadcast({ type: 'task', task: clone });
    runner.startTask(clone.id); // running or queued, per maxConcurrent
  }
}

setInterval(() => {
  checkSchedules();
  runner.pumpQueue(); // safety sweep: catch any dep-freed card a pump missed
}, 60 * 1000);

// The runner executes code: never bind beyond loopback without a token gate.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !auth.getToken()) {
  console.error(
    `Refusing to bind ${HOST} without an access token.\n` +
    `Set one first:  openssl rand -hex 16 > data/auth-token   (or export KFK_TOKEN)`
  );
  process.exit(1);
}

// launchd's kickstart sends SIGTERM; a bare Ctrl-C sends SIGINT. Neither used
// to be handled, so a restart while cards were running just yanked the rug:
// children orphaned, and the debounced save could lose the final write. Now
// we stop every running child, mark its card honestly, and flush synchronously
// before exiting — a restart is safe even with cards in flight.
function shutdown() {
  runner.stopAll();
  ptylib.killAll(); // no orphan shells across a kickstart
  flush();
  singleton.release(); // the next start must not have to wait out our stale lock
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, HOST, () => {
  console.log(`kungfu-kanban running at http://localhost:${PORT}`);
  if (auth.getToken()) console.log('token gate: ON (cookie or Authorization: Bearer)');
  else console.log('token gate: off (loopback only) — for Tailscale: openssl rand -hex 16 > data/auth-token, then `tailscale serve --bg 4747`');
});
