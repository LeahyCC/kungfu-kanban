// Spawns the Claude Code CLI for a task and streams its output.
// Uses `claude -p --output-format stream-json`, which runs on the user's
// subscription login (OAuth) — no API key, no token billing.
// Follow-ups resume the card's session (`claude -r <id> -p …`) so the agent
// keeps its full context. A subscription-limit failure trips the cooldown:
// the card requeues and all auto flow pauses until the limit resets.
const { spawn } = require('child_process');
const { state, save, getTask, appendTranscript, clearTranscript } = require('./store');
const { notify } = require('./notify');
const prflow = require('./prflow');
const cooldown = require('./cooldown');
const models = require('./models');

const running = new Map(); // taskId -> child process
let broadcast = () => {};
let onFinish = () => {};

function setBroadcaster(fn) {
  broadcast = fn;
}

function setOnFinish(fn) {
  onFinish = fn;
}

function buildPrompt(task) {
  let prompt = task.prompt || '';
  if (task.skills && task.skills.length) {
    const lines = task.skills.map((s) => `- ${s}`).join('\n');
    prompt = `Use the following installed skill(s) via the Skill tool where relevant to this task:\n${lines}\n\n${prompt}`;
  }
  if (task.skillsAuto) {
    prompt = `Review your installed skills and use any that are genuinely relevant to this task via the Skill tool.\n\n${prompt}`;
  }
  return prompt;
}

function buildArgs(task, effModel) {
  const args = ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose'];
  const model = effModel || task.model;
  if (model && model !== 'default') args.push('--model', model);
  if (task.effort && task.effort !== 'default') args.push('--effort', task.effort);
  if (task.permissionMode) args.push('--permission-mode', task.permissionMode);
  if (task.agent) args.push('--agent', task.agent);
  if (task.worktree) args.push('--worktree', `kanban-${task.id.slice(0, 8)}`);
  return args;
}

function slotsFree() {
  return running.size < (state.settings.maxConcurrent || 2);
}

function pumpQueue() {
  if (cooldown.active()) return;
  if (!slotsFree()) return;
  const next = state.tasks.find((t) => t.status === 'queued');
  if (!next) return;
  if (next.pendingFollowUp) startResume(next);
  else startTask(next.id);
}

function queueTask(task) {
  task.status = 'queued';
  save();
  broadcast({ type: 'task', task });
}

function startTask(id) {
  const task = getTask(id);
  if (!task || running.has(id)) return { error: 'not startable' };

  if (cooldown.active() || !slotsFree()) {
    queueTask(task);
    return { queued: true, cooldown: cooldown.active() };
  }

  task.status = 'running';
  task.startedAt = new Date().toISOString();
  task.error = null;
  task.resultText = null;
  task.stats = null;
  clearTranscript(id);
  save();
  const eff = models.effective(task.model);
  if (eff !== task.model) {
    appendTranscript(id, { kind: 'init', text: `model fallback: ${task.model} is cooling — running on ${eff}` });
  }
  launch(task, buildArgs(task, eff), task.cwd || process.env.HOME);
  return { started: true };
}

// Follow-up: additional instructions for a card that already ran, resumed in
// the SAME session so the agent keeps its context. Queued like any run.
function followUp(id, message) {
  const task = getTask(id);
  if (!task) return { error: 'not found' };
  if (running.has(id) || task.status === 'running' || task.status === 'stopping') return { error: 'task is running' };
  if (!task.sessionId) return { error: 'no session to resume — run the card first' };
  task.pendingFollowUp = String(message).slice(0, 10_000);
  queueTask(task);
  pumpQueue();
  return { queued: true };
}

async function startResume(task) {
  if (running.has(task.id)) return;
  const message = task.pendingFollowUp;
  task.pendingFollowUp = null;
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  task.error = null;
  // Keep the card's prompt honest for Sensei reviews and retries.
  task.prompt = `${task.prompt}\n\n## Follow-up\n${message}`;
  save();

  // Resume inside the original worktree when there is one.
  let cwd = task.cwd || process.env.HOME;
  if (task.worktree) {
    try {
      const wt = await prflow.findWorktree(task.cwd, `kanban-${task.id.slice(0, 8)}`);
      if (wt) cwd = wt.path;
    } catch {}
  }

  appendTranscript(task.id, { kind: 'user', text: message });
  broadcast({ type: 'output', taskId: task.id, entry: { kind: 'user', text: message } });

  const args = ['-r', task.sessionId, '-p', message, '--output-format', 'stream-json', '--verbose'];
  if (task.permissionMode) args.push('--permission-mode', task.permissionMode);
  launch(task, args, cwd);
}

// Shared spawn + stream + close plumbing for fresh runs and follow-ups.
function launch(task, args, cwd) {
  const id = task.id;

  // Force subscription auth: never let an API key in the environment win.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const child = spawn('claude', args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(id, child);
  broadcast({ type: 'task', task });

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      handleEvent(task, evt);
    }
  });

  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  child.on('close', (code) => {
    running.delete(id);
    const t = getTask(id);
    if (!t) return pumpQueue();
    t.finishedAt = new Date().toISOString();
    const stopped = t.status === 'stopping';
    t.status = 'review';
    if (stopped) t.error = 'Stopped by user';
    else if (code !== 0) t.error = (stderr.trim() || `claude exited with code ${code}`).slice(-2000);

    // Model-specific cap/outage? Block that model and retry on the next down.
    if (!stopped && t.error && models.detect(t.error)) {
      const next = models.fallbackFor(t, t.error);
      if (next) {
        appendTranscript(id, { kind: 'init', text: `model fallback: ${t.modelUsed || t.model} unavailable — requeued on ${next}` });
        broadcast({ type: 'output', taskId: id, entry: { kind: 'init', text: `model fallback → ${next}` } });
        t.error = null;
        queueTask(t);
        pumpQueue();
        return;
      } // nowhere lower to go: fall through to the cooldown check
    }

    // Subscription limit? Trip the cooldown and requeue instead of failing.
    if (!stopped && t.error && cooldown.detect(t.error)) {
      cooldown.hit(t.error);
      t.error = null;
      queueTask(t); // waits out the cooldown, relaunches via pumpQueue
      return;
    }

    save();
    broadcast({ type: 'task', task: t });
    pumpQueue();
    if (stopped) return; // deliberate stop: no notification, no manager review
    finalize(t).finally(() => onFinish(t));
  });

  child.on('error', (err) => {
    running.delete(id);
    task.status = 'review';
    task.error = `Failed to launch claude CLI: ${err.message}`;
    save();
    broadcast({ type: 'task', task });
    pumpQueue();
  });
}

function handleEvent(task, evt) {
  let entry = null;

  if (evt.type === 'system' && evt.subtype === 'init') {
    task.sessionId = evt.session_id || null;
    task.modelUsed = evt.model || null;
    entry = { kind: 'init', text: `session ${evt.session_id || '?'} · model ${evt.model || '?'}` };
  } else if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        appendTranscript(task.id, { kind: 'assistant', text: block.text });
        broadcast({ type: 'output', taskId: task.id, entry: { kind: 'assistant', text: block.text } });
      } else if (block.type === 'tool_use') {
        const summary = summarizeToolUse(block);
        appendTranscript(task.id, { kind: 'tool', text: summary });
        broadcast({ type: 'output', taskId: task.id, entry: { kind: 'tool', text: summary } });
      }
    }
    save();
    return;
  } else if (evt.type === 'result') {
    task.resultText = (evt.result || '').slice(0, 50000);
    task.stats = {
      turns: evt.num_turns,
      durationMs: evt.duration_ms,
      costUsd: evt.total_cost_usd,
      inputTokens: evt.usage && evt.usage.input_tokens,
      outputTokens: evt.usage && evt.usage.output_tokens,
    };
    if (evt.is_error) task.error = (evt.result || 'errored').slice(0, 2000);
    entry = { kind: 'result', text: evt.result || '' };
  }

  if (entry) {
    appendTranscript(task.id, entry);
    save();
    broadcast({ type: 'output', taskId: task.id, entry });
    broadcast({ type: 'task', task });
  }
}

// Post-run: open (or update) a PR for worktree cards that asked for one, then
// notify. Runs before onFinish so the manager's snapshot includes the PR URL.
async function finalize(task) {
  let prUrl = null;
  if (!task.error && task.worktree && task.openPr) {
    try {
      prUrl = await prflow.openPr(task.id, broadcast);
    } catch {}
  }
  if (task.error) notify('Kungfu Kanban — task failed', `✕ ${task.title}`);
  else notify('Kungfu Kanban — ready for review', `${task.title}${prUrl ? ' · PR opened' : ''}`, prUrl || task.prUrl);
}

function summarizeToolUse(block) {
  const input = block.input || {};
  const detail =
    input.command || input.file_path || input.pattern || input.url || input.prompt || input.skill || '';
  return `${block.name} ${String(detail).slice(0, 160)}`.trim();
}

function stopTask(id) {
  const child = running.get(id);
  const task = getTask(id);
  if (!child || !task) return { error: 'not running' };
  task.status = 'stopping';
  save();
  broadcast({ type: 'task', task });
  child.kill('SIGTERM');
  setTimeout(() => {
    if (running.has(id)) child.kill('SIGKILL');
  }, 5000);
  return { stopping: true };
}

function isRunning(id) {
  return running.has(id);
}

module.exports = { startTask, stopTask, followUp, isRunning, setBroadcaster, setOnFinish, pumpQueue };
