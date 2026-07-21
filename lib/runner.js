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
const offline = require('./offline');
const errlog = require('./errlog');
const models = require('./models');
const awake = require('./awake');
const deps = require('./deps');
const { broadcast, subEnv } = require('./bus');

const running = new Map(); // taskId -> child process
const starting = new Set(); // taskIds mid-startResume (async) — hold their slot
const teleAt = new Map(); // taskId -> last telemetry broadcast (ms)
let onFinish = () => {};

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
  if (task.worktree) {
    args.push('--worktree', `kanban-${task.id.slice(0, 8)}`);
    // The session lives INSIDE the worktree, so the parent repo's paths are
    // out of bounds — even a Read of the main checkout permission-blocks a
    // headless card. Whitelist the repo so acceptEdits cards can see it.
    if (task.cwd) args.push('--add-dir', task.cwd);
  }
  return args;
}

// A worktree card's launch forks off the LOCAL default branch. If a parent
// card's PR merged since this machine last fetched, local main is stale and
// the child worktree silently misses the parent's just-merged code. Fast-
// forward local <default> from origin right before launch closes that
// window. No-ops quietly when offline (timeout) or when local isn't a plain
// repo; logs one line only when it actually moved the ref, skipped a dirty
// checkout, or found local diverged from origin.
//
// git refuses a plain `fetch <refspec>` into whichever branch is currently
// checked out ("refusing to fetch into branch ... checked out at ..."), so
// when the default branch IS the checkout, this uses `pull --ff-only`
// instead (only when the tree is clean); otherwise it fetches straight into
// the ref, refusing (not force-clobbering) on divergence.
async function syncDefaultBranch(task) {
  if (!task.worktree || !task.cwd) return;
  const isRepo = await prflow.run('git', ['rev-parse', '--is-inside-work-tree'], task.cwd, 5_000);
  if (!isRepo.ok) return;
  const head = await prflow.run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], task.cwd, 5_000);
  const branch = head.ok && head.out ? head.out.replace('refs/remotes/origin/', '') : 'main';
  const current = await prflow.run('git', ['branch', '--show-current'], task.cwd, 5_000);
  const checkedOut = current.ok && current.out === branch;

  const before = await prflow.run('git', ['rev-parse', `refs/heads/${branch}`], task.cwd, 5_000);
  let fetch;
  if (checkedOut) {
    const status = await prflow.run('git', ['status', '--porcelain'], task.cwd, 5_000);
    if (status.ok && status.out) {
      appendTranscript(task.id, { kind: 'init', text: `tree dirty — skipped base sync of ${branch} before launch` });
      return;
    }
    fetch = await prflow.run('git', ['pull', '--ff-only', 'origin', branch], task.cwd, 10_000);
  } else {
    fetch = await prflow.run('git', ['fetch', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], task.cwd, 10_000);
  }

  if (fetch.ok) {
    const after = await prflow.run('git', ['rev-parse', `refs/heads/${branch}`], task.cwd, 5_000);
    if (before.ok && after.ok && before.out !== after.out) {
      appendTranscript(task.id, {
        kind: 'init',
        text: `synced local ${branch} ${before.out.slice(0, 7)} → ${after.out.slice(0, 7)} from origin before launch`,
      });
    }
  } else if (/non-fast-forward|fetch first|rejected|refusing to fetch/i.test(fetch.err)) {
    appendTranscript(task.id, {
      kind: 'init',
      text: `local ${branch} has diverged from origin — skipped fast-forward sync before launch`,
    });
  }
}

function slotsFree() {
  return running.size + starting.size < (state.settings.maxConcurrent || 2);
}

// A group is one lane: at most one of its cards runs at a time, so an
// in-flight group drains before a fresh one starts (queue auto-fill only —
// startTask's manual launch deliberately skips this, see its comment).
// ponytail: single lane per group, no per-group parallelism knob — add if a
// group ever needs to fan out internally.
function occupiedGroups() {
  const busy = new Set();
  for (const t of state.tasks) {
    if (!t.group) continue;
    if (running.has(t.id) || starting.has(t.id) || t.status === 'running' || t.status === 'stopping') {
      busy.add(t.group);
    }
  }
  return busy;
}

function groupHasProgress(group) {
  return state.tasks.some((t) => t.group === group && ['running', 'review', 'done'].includes(t.status));
}

// Next launchable card: queued, all deps done, its group's lane free, cards
// from an already-in-progress group preferred over a fresh group, highest
// priority first, then FIFO (state.tasks is newest-first, so walk from the
// end for oldest-first).
function nextRunnable() {
  const busyGroups = occupiedGroups();
  let best = null;
  for (let i = state.tasks.length - 1; i >= 0; i--) {
    const t = state.tasks[i];
    if (t.status !== 'queued') continue;
    if (!deps.ready(t)) continue;
    if (t.group && busyGroups.has(t.group)) continue;
    if (!best) {
      best = t;
      continue;
    }
    const tProgress = t.group ? groupHasProgress(t.group) : false;
    const bestProgress = best.group ? groupHasProgress(best.group) : false;
    if (tProgress !== bestProgress) {
      if (tProgress) best = t;
      continue;
    }
    if ((t.priority || 0) > (best.priority || 0)) best = t;
  }
  return best;
}

// A queued card held behind a review-status (or backlog) dep means a human
// verdict — or simply queuing the dep — is the critical path; bubble that up
// instead of letting it sit buried in a transcript. Notifies once per landing
// (dedupe key: dep status + the finishedAt it notified for, so a re-run or a
// status change renotifies).
function notifyBlocker(dep) {
  const prUnshipped = deps.prUnshipped(dep);
  if (dep.status !== 'review' && dep.status !== 'backlog' && !prUnshipped) return;
  const key = `${dep.status}:${dep.finishedAt || 'none'}`;
  if (dep.blockNotifiedFor === key) return;
  const waiting = deps.dependentsOf(dep.id).filter((t) => t.status === 'queued');
  if (!waiting.length) return;
  dep.blockNotifiedFor = key;
  save();
  const names = waiting.map((t) => `"${t.title}"`).join(', ');
  const action = prUnshipped
    ? 'merge its PR'
    : dep.status === 'backlog'
    ? 'queue or run it'
    : dep.error
    ? 'it needs a fix or re-run'
    : dep.prUrl ? 'merge its PR (or approve the card)' : 'approve or reject it';
  notify(
    'Kungfu Kanban — your verdict is the bottleneck 🖐',
    `"${dep.title}" holds up ${waiting.length} queued card${waiting.length > 1 ? 's' : ''} (${names}) — ${action} to release`,
    dep.prUrl || undefined
  );
}

// A finished group (every remaining member done — an archived member is done
// by definition, it just isn't in state.tasks anymore to check) gets exactly
// one ping, stamped on its last-finished member so a later pump can't re-fire.
function notifyGroupCompletions() {
  const byGroup = new Map();
  for (const t of state.tasks) {
    if (!t.group) continue;
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group).push(t);
  }
  for (const [group, members] of byGroup) {
    if (members.some((t) => t.status !== 'done' || t.groupNotified)) continue;
    let last = members[0];
    for (const t of members) {
      if (Date.parse(t.finishedAt || 0) > Date.parse(last.finishedAt || 0)) last = t;
    }
    last.groupNotified = true;
    save();
    notify('Kungfu Kanban — group complete', `Group complete — ${group}: ${members.length}/${members.length} done ✓`);
  }
}

// Fill every free slot. Dep-blocked cards stay queued; they get their chance
// on the next pump (every finish, ship, delete, and the minute sweep pump).
function pumpQueue() {
  // Bottleneck sweep first — cheap (flag-deduped) and runs even in cooldown.
  for (const t of state.tasks) {
    if (t.status !== 'queued') continue;
    for (const d of deps.unmet(t)) notifyBlocker(d);
  }
  notifyGroupCompletions();
  const tried = new Set(); // a card re-parked mid-loop must not spin us
  while (!cooldown.active() && !offline.active() && slotsFree()) {
    const next = nextRunnable();
    if (!next || tried.has(next.id)) return;
    tried.add(next.id);
    if (next.pendingFollowUp) startResume(next);
    else startTask(next.id);
  }
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
  if (!task || running.has(id) || starting.has(id) || task.status === 'running' || task.status === 'stopping') {
    return { error: 'not startable' };
  }

  // Deliberately no group-lane check here: the lane only gates nextRunnable's
  // queue auto-fill. A human pressing run on a group card launches it right
  // away when slots allow — manual intent beats the lane.

  // Unmet dependencies park the card in Queued; pumpQueue launches it when
  // the last prerequisite ships. Running it would hit the very wall the dep
  // declares (that's the burn prose "stop if X hasn't merged" guards caused).
  const waiting = deps.unmet(task);
  if (waiting.length) {
    queueTask(task);
    return { queued: true, waitingOn: waiting.map((d) => d.title) };
  }

  if (cooldown.active() || offline.active() || !slotsFree()) {
    queueTask(task);
    return { queued: true, cooldown: cooldown.active(), offline: offline.active() };
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
  const args = buildArgs(task, eff);
  const cwd = task.cwd || process.env.HOME;
  starting.add(id); // hold the slot across the pre-launch fetch below
  syncDefaultBranch(task).finally(() => {
    starting.delete(id);
    launch(task, args, cwd);
  });
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
  if (running.has(task.id) || starting.has(task.id)) return;
  starting.add(task.id); // holds the slot across the awaits below
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
  if (task.worktree && task.cwd) args.push('--add-dir', task.cwd); // parent repo stays visible on resume
  launch(task, args, cwd);
}

// Shared spawn + stream + close plumbing for fresh runs and follow-ups.
function launch(task, args, cwd) {
  const id = task.id;
  task.runCwd = cwd; // where the session actually lives — claude -r is per-directory
  save();

  const env = subEnv();

  const child = spawn('claude', args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  starting.delete(id);
  running.set(id, child);
  awake.hold(child.pid); // no Mac sleep while this agent runs
  broadcast({ type: 'task', task });

  // A wedged claude process (network stall, hung MCP) would otherwise occupy
  // a concurrency slot and hold its no-sleep assertion forever. maxRunMinutes
  // 0 disables the watchdog entirely.
  const maxRunMinutes = state.settings.maxRunMinutes ?? 120;
  let watchdog = null;
  if (maxRunMinutes > 0) {
    watchdog = setTimeout(() => {
      task.watchdogMinutes = maxRunMinutes;
      stopTask(id);
    }, maxRunMinutes * 60_000);
  }

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

  let spawnErr = null;

  child.on('close', (code) => {
    running.delete(id);
    teleAt.delete(id);
    clearTimeout(watchdog);
    if (spawnErr) return; // 'error' already ran the launch-failed finish path
    const t = getTask(id);
    if (!t) return pumpQueue();
    t.finishedAt = new Date().toISOString();
    const stopped = t.status === 'stopping';
    t.status = 'review';
    if (stopped) {
      t.error = t.watchdogMinutes ? `stopped by watchdog after ${t.watchdogMinutes} min` : 'Stopped by user';
      t.watchdogMinutes = null;
    } else if (code !== 0) t.error = (stderr.trim() || `claude exited with code ${code}`).slice(-2000);

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

    // Lost internet? Requeue instead of failing — but only after a live probe
    // confirms the outage, because a card whose own work hit a connection
    // error (a dead localhost server in its tests, say) matches the same
    // patterns and must fail normally, not loop forever.
    if (!stopped && !t.permissionBlocked && t.error && offline.detect(t.error)) {
      const errText = t.error;
      offline.probe().then((down) => {
        if (down) {
          offline.hit(errText);
          appendTranscript(id, { kind: 'init', text: 'internet connection lost — card requeued; relaunches when back online' });
          broadcast({ type: 'output', taskId: id, entry: { kind: 'init', text: 'offline — requeued until the connection returns' } });
          t.error = null;
          queueTask(t);
        } else {
          settle();
        }
      });
      return;
    }

    settle();

    // Error tracker: a deliberate stop is not an error; everything else either
    // logs (permission block / failed run) or clears this card's earlier
    // run-level entries (the clean finish IS the fix).
    function settle() {
      if (!stopped) {
        if (t.error && t.permissionBlocked) {
          const head = t.permissionBlocked[0] || 'a tool';
          const more = t.permissionBlocked.length > 1 ? ` (+${t.permissionBlocked.length - 1} more)` : '';
          errlog.capture('permission', {
            taskId: t.id, taskTitle: t.title,
            text: `blocked at ${t.permissionMode || 'acceptEdits'}: ${head}${more}`,
            detail: t.permissionBlocked.join('\n'),
          });
        } else if (t.error) {
          errlog.capture('run-failed', { taskId: t.id, taskTitle: t.title, text: t.error });
        } else {
          errlog.resolveTask(t.id, ['permission', 'run-failed', 'launch-failed']);
        }
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
    }
  });

  child.on('error', (err) => {
    spawnErr = err;
    running.delete(id);
    clearTimeout(watchdog);
    task.status = 'review';
    task.error = `Failed to launch claude CLI: ${err.message}`;
    errlog.capture('launch-failed', { taskId: id, taskTitle: task.title, text: task.error });
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
    // At bypassPermissions there is no mode left to raise: a denial can only
    // come from an explicit deny rule in .claude/settings.json — a deliberate
    // user guardrail the agent worked around or noted. Flagging the card
    // "blocked" would be a false alarm whose only remedy button (bypass &
    // re-run) re-hits the same rule forever. Note it in the transcript, move on.
    if (denials.length && task.permissionMode === 'bypassPermissions') {
      const note = `deny-rule denial (not a permission block): ${denials.map(summarizeDenial).join('; ').slice(0, 500)}`;
      appendTranscript(task.id, { kind: 'init', text: note });
      broadcast({ type: 'output', taskId: task.id, entry: { kind: 'init', text: note } });
    } else if (denials.length) {
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
    `.claude/settings.json, then re-run. (If the command matches a deny rule in your ` +
    `settings, that rule wins at every mode — remove or reword it instead.)`
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

// Server shutdown: SIGTERM every live child and label its card honestly so a
// restart never reads as a clean finish. No SIGKILL escalation like stopTask —
// the process exits right behind this, so there's no time left to wait for one.
function stopAll() {
  for (const [id, child] of running) {
    const task = getTask(id);
    if (task) {
      task.status = 'review';
      task.error = 'interrupted by server restart';
      task.finishedAt = new Date().toISOString();
    }
    child.kill('SIGTERM');
  }
}

module.exports = { startTask, stopTask, stopAll, followUp, isRunning, setOnFinish, pumpQueue, nextRunnable, notifyGroupCompletions, buildPrompt, buildArgs, handleEvent };
