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
const awake = require('./awake');

const running = new Map(); // taskId -> child process
const teleAt = new Map(); // taskId -> last telemetry broadcast (ms)
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
  // A card queued into an active cooldown has nothing running to hold an
  // assertion — keep the Mac up so the reset timer can fire and relaunch it.
  if (cooldown.active()) awake.holdUntil(cooldown.until() + 60_000);
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
  task.permissionBlocked = null;
  task.resultText = null;
  task.stats = null;
  task.ctxTokens = null;
  task.liveOut = 0;
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
  task.permissionBlocked = null;
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
  // Honor the card's (possibly just-changed) model/effort on resume too.
  const eff = models.effective(task.model);
  if (eff && eff !== 'default') args.push('--model', eff);
  if (task.effort && task.effort !== 'default') args.push('--effort', task.effort);
  if (task.permissionMode) args.push('--permission-mode', task.permissionMode);
  launch(task, args, cwd);
}

// Shared spawn + stream + close plumbing for fresh runs and follow-ups.
function launch(task, args, cwd) {
  const id = task.id;
  task.runCwd = cwd; // where the session actually lives — claude -r is per-directory
  save();

  // Force subscription auth: never let an API key in the environment win.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const child = spawn('claude', args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(id, child);
  awake.hold(child.pid); // no Mac sleep while this agent runs
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
    teleAt.delete(id);
    const t = getTask(id);
    if (!t) return pumpQueue();
    t.finishedAt = new Date().toISOString();
    const stopped = t.status === 'stopping';
    t.status = 'review';
    if (stopped) t.error = 'Stopped by user';
    else if (code !== 0) t.error = (stderr.trim() || `claude exited with code ${code}`).slice(-2000);

    // Model-specific cap/outage? Block that model and retry on the next down.
    // A permission-blocked run is never a model outage — and its error embeds
    // the denied command verbatim, which could otherwise false-match here.
    if (!stopped && !t.permissionBlocked && t.error && models.detect(t.error)) {
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
    // Same guard: a blocked card must not masquerade as a subscription limit
    // (its error carries the denied command text) and re-arm a board-wide freeze.
    if (!stopped && !t.permissionBlocked && t.error && cooldown.detect(t.error)) {
      cooldown.hit(t.error);
      t.error = null;
      queueTask(t); // waits out the cooldown, relaunches via pumpQueue
      return;
    }

    save();
    broadcast({ type: 'task', task: t });
    pumpQueue();
    if (stopped) return; // deliberate stop: no notification, no manager review
    // The agent's assertion died with its pid, but finalize (PR push) and the
    // Sensei handoff still run — bridge them so the last card's exit doesn't
    // let the Mac sleep mid-push. The Sensei's own run holds its own pid.
    awake.holdUntil(Date.now() + 5 * 60_000);
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
    // Live session telemetry: context size ≈ everything the model just read;
    // liveOut accumulates output tokens across turns for the running badge.
    // Broadcast at most every 2s per task — every task event rebuilds the
    // whole board client-side, so chatty agents would make the UI churn.
    const u = evt.message.usage;
    if (u) {
      task.ctxTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      task.liveOut = (task.liveOut || 0) + (u.output_tokens || 0);
      const nowMs = Date.now();
      if ((teleAt.get(task.id) || 0) + 2000 < nowMs) {
        teleAt.set(task.id, nowMs);
        broadcast({ type: 'task', task });
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
    // A headless run can end "successfully" having accomplished nothing because
    // a tool it needed was permission-blocked — a Bash command that must leave
    // the sandbox, a deny rule, or a mode that won't auto-approve Bash. The CLI
    // reports that as `permission_denials`; there is no interactive prompt to
    // satisfy, and a natural-language "yes" follow-up just re-hits the same wall
    // (an invisible loop that burns the subscription). Surface it as a blocked
    // card carrying the real remedy instead of a clean review.
    const denials = Array.isArray(evt.permission_denials) ? evt.permission_denials : [];
    if (denials.length) {
      task.permissionBlocked = denials.map(summarizeDenial);
      const note = blockedMessage(task);
      // The block is the actionable root cause, so it leads task.error even when
      // the CLI also flagged is_error — that's what the manager snapshot reads,
      // and its anti-loop guidance keys off this text. The raw error, if any,
      // survives in resultText and the result transcript entry.
      task.error = note;
      appendTranscript(task.id, { kind: 'blocked', text: note });
      broadcast({ type: 'output', taskId: task.id, entry: { kind: 'blocked', text: note } });
    }
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

// One blocked tool call → a short "Bash <command>" style label.
function summarizeDenial(d) {
  const input = (d && d.tool_input) || {};
  const detail = input.command || input.file_path || input.url || input.pattern || '';
  return `${(d && d.tool_name) || 'a tool'} ${String(detail).slice(0, 160)}`.trim();
}

// The actionable card error when a headless run was permission-blocked. The
// non-obvious part users hit: replying "yes" can't grant a headless permission,
// so we name the real levers (raise the card's mode, or add an allow-rule).
function blockedMessage(task) {
  const list = task.permissionBlocked || [];
  const head = list[0] || 'a tool';
  const more = list.length > 1 ? ` (+${list.length - 1} more)` : '';
  return (
    `Blocked on permission — the agent needed to run ${head}${more}, but this ` +
    `card's permission mode (${task.permissionMode || 'acceptEdits'}) doesn't allow it ` +
    `and headless cards have no approval prompt, so replying "yes" can't grant it. ` +
    `Raise this card's Permissions (e.g. bypassPermissions) or add an allow-rule to ` +
    `.claude/settings.json, then re-run.`
  );
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
