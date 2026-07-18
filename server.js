const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { discoverSkills, discoverAgents, discoverRepos } = require('./lib/discovery');
const os = require('os');
const { state, save, getTask, readTranscript, sweepArchive } = require('./lib/store');
const runner = require('./lib/runner');
const manager = require('./lib/manager');
const auth = require('./lib/auth');
const importer = require('./lib/importer');
const prwatch = require('./lib/prwatch');
const cooldown = require('./lib/cooldown');
const models = require('./lib/models');
const depsLib = require('./lib/deps');

const PORT = process.env.PORT || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const app = express();
app.use(express.json({ limit: '1mb' }));
auth.install(app); // token gate (only active when a token is configured) — must precede static
app.use(express.static(path.join(__dirname, 'public')));

// --- Server-sent events ---
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) res.write(data);
}
runner.setBroadcaster(broadcast);
manager.setBroadcaster(broadcast);
importer.setBroadcaster(broadcast);
prwatch.setBroadcaster(broadcast);
prwatch.applyInterval();
cooldown.setBroadcaster(broadcast);
models.setBroadcaster(broadcast);
setTimeout(() => prwatch.sweep(), 30_000); // first pass shortly after boot
runner.setOnFinish((task) => {
  if (manager.config().triggers.onFinish) {
    manager.invoke(`task finished and awaits review: "${task.title}" (id ${task.id})`);
  }
});
manager.applyInterval();

// --- Archive sweep: move old "done" cards to data/archive.jsonl daily ---
function runArchiveSweep() {
  const archived = sweepArchive();
  for (const t of archived) broadcast({ type: 'deleted', taskId: t.id });
}
runArchiveSweep();
setInterval(runArchiveSweep, 24 * 60 * 60 * 1000);

// --- Config: models, efforts, skills, agents ---
const MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];

function reposDir() {
  return state.settings.reposDir || path.join(os.homedir(), 'Documents', 'Code', 'Git');
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
    modelBlocks: models.blocks(),
    authGate: !!auth.getToken(), // the UI shows Sign out only when a gate exists
  });
});

app.put('/api/settings', (req, res) => {
  const { maxConcurrent, defaultCwd, archiveDays, ntfyTopic, notifyMac, keepAwake, reposDir: rd, prWatchMin, prWatchAutoFix } = req.body || {};
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
  if (typeof defaultCwd === 'string') state.settings.defaultCwd = defaultCwd.trim(); // empty clears it
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
  save();
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
            (i.body || i.title).trim().slice(0, 3000),
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

// The kungfu-todo Claude Code skill: check + one-click install/update.
const skill = require('./lib/skill');
// Auto-install/refresh at boot — the skill bakes in this install's absolute
// paths and port, so a moved clone or changed PORT re-syncs on next start.
try {
  const s = skill.status();
  if (!s.current) {
    skill.install();
    console.log(`kungfu-todo skill ${s.installed ? 'refreshed' : 'installed'}: ${s.path}`);
  }
} catch (e) {
  console.warn('kungfu-todo skill auto-install failed:', String(e.message || e));
}
app.get('/api/skill', (req, res) => res.json(skill.status()));
app.post('/api/skill/install', (req, res) => {
  try {
    res.json({ ok: true, ...skill.install() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
});

// Rolling 5-hour usage across all local Claude Code activity. Cached 2 min.
app.get('/api/usage', (req, res) => {
  res.json({ ...require('./lib/usage').scan(), budgetTokens: state.settings.usageBudgetTokens || 0 });
});

// Update the Claude Code CLI in place (`claude update` knows its own install
// method). Running agents keep their already-loaded binary; new runs get the
// new version.
app.post('/api/system/update-claude', (req, res) => {
  execFile('claude', ['update'], { timeout: 300_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    healthCache = { at: 0, data: null }; // version may have changed — recheck
    const out = `${stdout || ''}\n${stderr || ''}`.trim().split('\n').filter(Boolean).slice(-3).join('\n');
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
  const args = action === 'merge' ? ['pr', 'merge', task.prUrl, '--merge'] : ['pr', 'close', task.prUrl];
  execFile('gh', args, { timeout: 60_000, cwd: task.cwd }, (err, stdout, stderr) => {
    const note = (kind, text) => {
      require('./lib/store').appendTranscript(task.id, { kind, text });
      broadcast({ type: 'output', taskId: task.id, entry: { kind, text } });
    };
    if (err) {
      const msg = (stderr || err.message || '').trim().slice(0, 300);
      note('error', `PR ${action} failed — ${msg}`);
      return res.status(500).json({ error: msg });
    }
    if (action === 'merge') {
      task.status = 'done';
      task.managerVerdict = 'PR merged';
      note('pr', 'PR merged from the board');
      require('./lib/notify').notify('Kungfu Kanban — PR merged', task.title, task.prUrl);
      runner.pumpQueue(); // the merge may free dependent cards
    } else {
      task.prClosedNoted = true;
      note('pr', 'PR closed from the board (not merged)');
    }
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
  'skills', 'skillsAuto', 'agent', 'worktree', 'openPr', 'status', 'priority', 'acceptanceCriteria',
  'schedule', 'issueNumber',
  'prUrl', // repair hatch: lets a manually-created PR be attached to its card
];
const STATUSES = ['backlog', 'queued', 'running', 'stopping', 'review', 'done'];

// A card's optional `schedule` is either a repeating interval in hours or a
// daily HH:MM time. The client sends a freeform "repeat" string ("6h", "14:30");
// we normalize it to an object (or null). Passing an already-normalized object
// back through is idempotent so re-saves don't lose the parse or `lastFired`.
function parseSchedule(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw.kind ? raw : null;
  const s = String(raw).trim();
  if (!s) return null;
  const daily = s.match(/^(\d{1,2}):(\d{2})$/);
  if (daily) {
    const h = +daily[1];
    const m = +daily[2];
    if (h > 23 || m > 59) return null;
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return { kind: 'daily', time, lastFired: null };
  }
  const interval = s.match(/^(\d+(?:\.\d+)?)\s*h?$/i);
  if (interval) {
    const hours = parseFloat(interval[1]);
    if (hours > 0) return { kind: 'interval', hours, lastFired: null };
  }
  return null;
}

function makeTask(b, createdBy = 'user') {
  return {
    id: crypto.randomUUID(),
    title: (b.title || 'Untitled task').slice(0, 200),
    prompt: b.prompt || '',
    cwd: b.cwd || state.settings.defaultCwd,
    model: b.model || 'default',
    effort: b.effort || 'default',
    permissionMode: b.permissionMode || 'acceptEdits',
    skills: Array.isArray(b.skills) ? b.skills : [],
    skillsAuto: !!b.skillsAuto,
    agent: b.agent || null,
    worktree: !!b.worktree,
    openPr: !!b.openPr,
    priority: Number.isInteger(b.priority) ? b.priority : 0,
    acceptanceCriteria: b.acceptanceCriteria || '',
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

app.get('/api/tasks', (req, res) => res.json(state.tasks));

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
  if ('deps' in req.body) {
    const clean = depsLib.sanitize(req.body.deps, task.id);
    if (depsLib.wouldCycle(task.id, clean)) {
      return res.status(400).json({ error: 'dependency cycle — a card cannot (transitively) wait on itself' });
    }
    task.deps = clean;
    delete task.depsUnresolved;
  }
  for (const f of TASK_FIELDS) {
    if (f in req.body) task[f] = req.body[f];
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
  broadcast({ type: 'deleted', taskId: task.id });
  runner.pumpQueue(); // a deleted dep counts as met — free any waiting dependents
  res.json({ ok: true });
});

app.get('/api/tasks/:id/transcript', (req, res) => {
  res.json(readTranscript(req.params.id));
});

app.post('/api/tasks/:id/run', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (runner.isRunning(task.id)) return res.status(409).json({ error: 'already running' });
  res.json(runner.startTask(task.id));
});

app.post('/api/tasks/:id/stop', (req, res) => {
  res.json(runner.stopTask(req.params.id));
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

app.put('/api/manager/config', (req, res) => {
  const c = manager.config();
  const b = req.body || {};
  for (const f of ['enabled', 'model', 'effort', 'autonomy', 'stylePrompt', 'maxLaunchesPerHour', 'maxRetries', 'permissionCeiling']) {
    if (f in b) c[f] = b[f];
  }
  if (b.triggers) c.triggers = { ...c.triggers, ...b.triggers };
  save();
  manager.applyInterval();
  res.json(c);
});

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
function localDay(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function scheduleDue(task, now) {
  const sc = task.schedule;
  if (!sc) return false;
  if (sc.kind === 'interval') {
    const last = sc.lastFired ? new Date(sc.lastFired) : new Date(task.createdAt);
    return now - last >= sc.hours * 3600 * 1000;
  }
  if (sc.kind === 'daily') {
    // Due once the target time has passed today — not only in the exact
    // minute — so a sleeping laptop catches up on wake instead of skipping.
    const [h, m] = sc.time.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (now < target) return false;
    return !sc.lastFired || localDay(new Date(sc.lastFired)) !== localDay(now);
  }
  return false;
}

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

app.listen(PORT, HOST, () => {
  console.log(`kungfu-kanban running at http://localhost:${PORT}`);
  if (auth.getToken()) console.log('token gate: ON (cookie or Authorization: Bearer)');
  else console.log('token gate: off (loopback only) — for Tailscale: openssl rand -hex 16 > data/auth-token, then `tailscale serve --bg 4747`');
});
