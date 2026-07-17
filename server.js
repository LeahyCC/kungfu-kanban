const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { discoverSkills, discoverAgents } = require('./lib/discovery');
const { state, save, getTask, readTranscript } = require('./lib/store');
const runner = require('./lib/runner');

const PORT = process.env.PORT || 4747;
const app = express();
app.use(express.json({ limit: '1mb' }));
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
  const { maxConcurrent, defaultCwd } = req.body || {};
  if (Number.isInteger(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 8) {
    state.settings.maxConcurrent = maxConcurrent;
  }
  if (typeof defaultCwd === 'string' && defaultCwd) state.settings.defaultCwd = defaultCwd;
  save();
  res.json(state.settings);
});

// --- Tasks ---
const TASK_FIELDS = [
  'title', 'prompt', 'cwd', 'model', 'effort', 'permissionMode',
  'skills', 'agent', 'worktree', 'status',
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
    status: 'backlog',
    createdAt: new Date().toISOString(),
    sessionId: null,
    error: null,
    resultText: null,
    stats: null,
  };
  state.tasks.unshift(task);
  save();
  broadcast({ type: 'task', task });
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-kanban running at http://localhost:${PORT}`);
});
