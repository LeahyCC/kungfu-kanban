// Spawns the Claude Code CLI for a task and streams its output.
// Uses `claude -p --output-format stream-json`, which runs on the user's
// subscription login (OAuth) — no API key, no token billing.
const { spawn } = require('child_process');
const { state, save, getTask, appendTranscript, clearTranscript } = require('./store');
const { notify } = require('./notify');
const prflow = require('./prflow');

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

function buildArgs(task) {
  const args = ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose'];
  if (task.model && task.model !== 'default') args.push('--model', task.model);
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
  if (!slotsFree()) return;
  const next = state.tasks.find((t) => t.status === 'queued');
  if (next) startTask(next.id);
}

function startTask(id) {
  const task = getTask(id);
  if (!task || running.has(id)) return { error: 'not startable' };

  if (!slotsFree()) {
    task.status = 'queued';
    save();
    broadcast({ type: 'task', task });
    return { queued: true };
  }

  task.status = 'running';
  task.startedAt = new Date().toISOString();
  task.error = null;
  task.resultText = null;
  task.stats = null;
  clearTranscript(id);
  save();

  // Force subscription auth: never let an API key in the environment win.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const child = spawn('claude', buildArgs(task), {
    cwd: task.cwd || process.env.HOME,
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

  return { started: true };
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

// Post-run: open a PR for worktree cards that asked for one, then notify.
// Runs before onFinish so the manager's review snapshot includes the PR URL.
async function finalize(task) {
  let prUrl = null;
  if (!task.error && task.worktree && task.openPr) {
    try {
      prUrl = await prflow.openPr(task.id, broadcast);
    } catch {}
  }
  if (task.error) notify('Kungfu Kanban — task failed', `✕ ${task.title}`);
  else notify('Kungfu Kanban — ready for review', `${task.title}${prUrl ? ' · PR opened' : ''}`, prUrl);
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

module.exports = { startTask, stopTask, isRunning, setBroadcaster, setOnFinish, pumpQueue };
