const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { discoverSkills, discoverAgents } = require('./lib/discovery');
const { state, save, getTask, readTranscript } = require('./lib/store');
const runner = require('./lib/runner');
const manager = require('./lib/manager');

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
  'skills', 'agent', 'worktree', 'status', 'priority', 'acceptanceCriteria',
  'schedule',
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
    agent: b.agent || null,
    worktree: !!b.worktree,
    priority: Number.isInteger(b.priority) ? b.priority : 0,
    acceptanceCriteria: b.acceptanceCriteria || '',
    schedule: parseSchedule(b.schedule),
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
  for (const f of TASK_FIELDS) {
    if (f in req.body) task[f] = req.body[f];
  }
  if ('schedule' in req.body) task.schedule = parseSchedule(req.body.schedule);
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
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    if (`${hh}:${mm}` !== sc.time) return false;
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

setInterval(checkSchedules, 60 * 1000);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-kanban running at http://localhost:${PORT}`);
});
