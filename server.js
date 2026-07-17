const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { discoverSkills, discoverAgents } = require('./lib/discovery');
const { state, save, getTask, readTranscript } = require('./lib/store');
const runner = require('./lib/runner');
const manager = require('./lib/manager');
const auth = require('./lib/auth');

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
runner.setOnFinish((task) => {
  if (manager.config().triggers.onFinish) {
    manager.invoke(`task finished and awaits review: "${task.title}" (id ${task.id})`);
  }
});
manager.applyInterval();

// --- Config: models, efforts, skills, agents ---
const MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];

app.get('/api/config', (req, res) => {
  res.json({
    models: MODELS,
    efforts: EFFORTS,
    permissionModes: PERMISSION_MODES,
    skills: discoverSkills(),
    agents: discoverAgents(),
    settings: state.settings,
  });
});

app.put('/api/settings', (req, res) => {
  const { maxConcurrent, defaultCwd, ntfyTopic, notifyMac } = req.body || {};
  if (Number.isInteger(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 8) {
    state.settings.maxConcurrent = maxConcurrent;
  }
  if (typeof defaultCwd === 'string' && defaultCwd) state.settings.defaultCwd = defaultCwd;
  if (typeof ntfyTopic === 'string') state.settings.ntfyTopic = ntfyTopic.trim();
  if (typeof notifyMac === 'boolean') state.settings.notifyMac = notifyMac;
  save();
  res.json(state.settings);
});

// Fire both notification channels on demand, for wiring up phones.
app.post('/api/notify/test', (req, res) => {
  require('./lib/notify').notify('Kungfu Kanban — test 🥋', 'If you can read this, notifications work.');
  res.json({ ok: true, topic: state.settings.ntfyTopic || null });
});

// --- Tasks ---
const TASK_FIELDS = [
  'title', 'prompt', 'cwd', 'model', 'effort', 'permissionMode',
  'skills', 'agent', 'worktree', 'openPr', 'status', 'priority', 'acceptanceCriteria',
];
const STATUSES = ['backlog', 'queued', 'running', 'stopping', 'review', 'done'];

app.get('/api/tasks', (req, res) => res.json(state.tasks));

app.post('/api/tasks', (req, res) => {
  const b = req.body || {};
  const task = {
    id: crypto.randomUUID(),
    title: (b.title || 'Untitled task').slice(0, 200),
    prompt: b.prompt || '',
    cwd: b.cwd || state.settings.defaultCwd,
    model: b.model || 'default',
    effort: b.effort || 'default',
    permissionMode: b.permissionMode || 'acceptEdits',
    skills: Array.isArray(b.skills) ? b.skills : [],
    agent: b.agent || null,
    worktree: !!b.worktree,
    openPr: !!b.openPr,
    priority: Number.isInteger(b.priority) ? b.priority : 0,
    acceptanceCriteria: b.acceptanceCriteria || '',
    status: 'backlog',
    createdAt: new Date().toISOString(),
    createdBy: 'user',
    retries: 0,
    sessionId: null,
    error: null,
    resultText: null,
    stats: null,
  };
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
  for (const f of TASK_FIELDS) {
    if (f in req.body) task[f] = req.body[f];
  }
  if (!STATUSES.includes(task.status)) task.status = 'backlog';
  save();
  broadcast({ type: 'task', task });
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (runner.isRunning(task.id)) return res.status(409).json({ error: 'stop it first' });
  state.tasks = state.tasks.filter((t) => t.id !== task.id);
  save();
  broadcast({ type: 'deleted', taskId: task.id });
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
