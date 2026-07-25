const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { discoverSkills, discoverAgents, discoverRepos, defaultReposDir } = require('./lib/discovery');
const os = require('os');
const { state, save, saveSettings, flush, getTask, readTranscript, clearTranscript, sweepArchive, nextRev } = require('./lib/store');
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
    // cancelled in the UI → stop the claude process, don't burn usage
    req.on('close', () => { if (!res.writableEnded) op.kill(); });
    res.json(await op.promise);
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
  res.json({ ...usage, budgetTokens: state.settings.usageBudgetTokens || 0 });
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

app.get('/api/tasks/:id/transcript', (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(readTranscript(req.params.id));
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
  flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, HOST, () => {
  console.log(`kungfu-kanban running at http://localhost:${PORT}`);
  if (auth.getToken()) console.log('token gate: ON (cookie or Authorization: Bearer)');
  else console.log('token gate: off (loopback only) — for Tailscale: openssl rand -hex 16 > data/auth-token, then `tailscale serve --bg 4747`');
});
