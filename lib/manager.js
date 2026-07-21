// The Manager: an LLM (via `claude -p` on the user's subscription) that
// triages, routes, dispatches, and reviews task cards. Returns structured
// actions which are executed or queued as suggestions per the autonomy level.
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { state, save, getTask, writeJsonAtomic, DATA_DIR } = require('./store');
const runner = require('./runner');
const errlog = require('./errlog');
const { broadcast, subEnv } = require('./bus');

const MGR_FILE = path.join(DATA_DIR, 'manager.json');
const MGR_LOG = path.join(DATA_DIR, 'manager-log.jsonl');

// permissiveness order, least → most; the ceiling clamps what the manager may assign
const PERM_ORDER = ['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'];

const DEFAULT_CONFIG = {
  enabled: true,
  model: 'opus',
  effort: 'medium',
  autonomy: 'suggest', // suggest | semi | auto
  stylePrompt: '',
  triggers: { onFinish: true, onNewCard: true, intervalMin: 0 },
  maxLaunchesPerHour: 10,
  maxRetries: 2,
  permissionCeiling: 'acceptEdits',
};

function config() {
  state.settings.manager = { ...DEFAULT_CONFIG, ...(state.settings.manager || {}) };
  state.settings.manager.triggers = {
    ...DEFAULT_CONFIG.triggers,
    ...(state.settings.manager.triggers || {}),
  };
  return state.settings.manager;
}

// --- persistent manager state (suggestions, chat, launch timestamps) ---
function readMgrState() {
  try {
    return JSON.parse(fs.readFileSync(MGR_FILE, 'utf8'));
  } catch {
    return { suggestions: [], chat: [], launches: [] };
  }
}
const mgr = readMgrState();
function saveMgr() {
  writeJsonAtomic(MGR_FILE, mgr);
}

function log(kind, text, extra = {}) {
  const entry = { ts: new Date().toISOString(), kind, text, ...extra };
  fs.appendFileSync(MGR_LOG, JSON.stringify(entry) + '\n');
  trimLog();
  broadcast({ type: 'manager', event: 'log', entry });
  // A failed Sensei action or errored Sensei run is itself an operational
  // error — track it so "fix the errors" covers the manager's own stumbles.
  if (kind === 'error') {
    const t = extra.action && extra.action.taskId ? getTask(extra.action.taskId) : null;
    errlog.capture('sensei', { taskId: t ? t.id : null, taskTitle: t ? t.title : null, text });
  }
  return entry;
}

// ponytail: statSync gate keeps normal appends cheap; only reads+rewrites once the file is actually big
function trimLog() {
  let size;
  try {
    size = fs.statSync(MGR_LOG).size;
  } catch {
    return;
  }
  if (size < 200_000) return; // ~2000 lines' worth, rough
  const lines = fs.readFileSync(MGR_LOG, 'utf8').split('\n').filter(Boolean);
  if (lines.length > 2000) fs.writeFileSync(MGR_LOG, lines.slice(-500).join('\n') + '\n');
}

function readLog(n = 40) {
  try {
    const lines = fs.readFileSync(MGR_LOG, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// --- guardrails ---
function launchesInLastHour() {
  const cutoff = Date.now() - 3600_000;
  mgr.launches = mgr.launches.filter((t) => t > cutoff);
  return mgr.launches.length;
}

function clampPermission(mode) {
  const c = config();
  const ceiling = PERM_ORDER.indexOf(c.permissionCeiling);
  const idx = PERM_ORDER.indexOf(mode);
  if (idx === -1 || idx > ceiling) return c.permissionCeiling;
  return mode;
}

// --- the action schema the manager must return ---
const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Short message to the human summarizing what you did/recommend.' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['create_task', 'update_task', 'run_task', 'approve_task', 'reject_task', 'followup_task', 'requeue_task', 'retarget_pr', 'merge_pr', 'resolve_error', 'note'],
          },
          taskId: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          cwd: { type: 'string' },
          model: { type: 'string', enum: ['default', 'fable', 'opus', 'sonnet', 'haiku'] },
          effort: { type: 'string', enum: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
          permissionMode: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
          skillsAuto: { type: 'boolean', description: 'let the executing agent pick relevant skills itself instead of a fixed list' },
          worktree: { type: 'boolean' },
          openPr: { type: 'boolean', description: 'worktree cards only: push the branch and open a GitHub PR when the run succeeds' },
          prBaseBranch: { type: 'string', description: 'PR base branch (e.g. staging) for repos whose branch guards reject PRs into the default branch' },
          deps: { type: 'array', items: { type: 'string' }, description: 'prerequisites this card must wait for — task ids, or the EXACT title of another card (including one created earlier in this same actions array); it stays queued until every one is done' },
          priority: { type: 'integer', minimum: 0, maximum: 3 },
          acceptanceCriteria: { type: 'string' },
          group: { type: 'string', description: 'label to visually cluster related cards on the board, e.g. the name of the batch they came from' },
          autoRun: { type: 'boolean', description: 'create_task only: launch immediately after creating' },
          feedback: { type: 'string', description: 'reject_task: what to fix on the retry' },
          message: { type: 'string', description: 'followup_task: precise, small fix to make — name the file and the exact change; the same session resumes with this instruction' },
          errorId: { type: 'string', description: 'resolve_error: the error-tracker entry id being marked handled' },
          reasoning: { type: 'string' },
        },
        required: ['type', 'reasoning'],
      },
    },
  },
  required: ['reply', 'actions'],
};

// The self-report (resultText) is the agent grading its own homework — the
// 0.13.0 batch had two flaws (an unsafe rename order, a no-op git refspec)
// that read fine in the self-report and were obvious in the diff. Fetch it
// for review cards so the Sensei can actually check the work.
const DIFF_LINE_CAP = 400;
const DIFF_BYTE_CAP = 20 * 1024;
async function prDiffForReview(t) {
  try {
    const { stdout } = await execFileP('gh', ['pr', 'diff', t.prUrl], {
      cwd: t.cwd,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    let truncated = false;
    let lines = stdout.split('\n');
    if (lines.length > DIFF_LINE_CAP) {
      lines = lines.slice(0, DIFF_LINE_CAP);
      truncated = true;
    }
    let text = lines.join('\n');
    if (text.length > DIFF_BYTE_CAP) {
      text = text.slice(0, DIFF_BYTE_CAP);
      truncated = true;
    }
    if (truncated) text += `\n... [diff truncated — ${stdout.length - text.length} more characters omitted]`;
    return text;
  } catch (e) {
    const reason = String(e.stderr || e.message || e).replace(/\s+/g, ' ').trim().slice(0, 200);
    return `diff unavailable: ${reason}`;
  }
}

// --- snapshot of the board for the manager prompt ---
async function snapshot() {
  const depsLib = require('./deps');
  const rows = state.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    group: t.group || undefined,
    priority: t.priority || 0,
    model: t.model,
    effort: t.effort,
    permissionMode: t.permissionMode,
    skills: t.skills,
    skillsAuto: !!t.skillsAuto,
    cwd: t.cwd,
    retries: t.retries || 0,
    error: t.error ? String(t.error).slice(0, 300) : null,
    permissionBlocked: t.permissionBlocked || null,
    stats: t.stats || null,
    acceptanceCriteria: t.acceptanceCriteria || null,
    prompt: (t.prompt || '').slice(0, 400),
    prUrl: t.prUrl || null,
    prBaseBranch: t.prBaseBranch || undefined,
    prChecks: t.prChecks
      ? { base: t.prChecks.base, passing: t.prChecks.passing, failing: t.prChecks.failing, pending: t.prChecks.pending, failed: t.prChecks.failed, wrongBase: t.prChecks.wrongBase }
      : undefined,
    deps: (t.deps || []).length
      ? t.deps.map((id) => {
          const d = getTask(id);
          return d ? { id, title: d.title, status: d.status } : { id, status: 'gone (counts as met)' };
        })
      : undefined,
    depsUnresolved: (t.depsUnresolved || []).length ? t.depsUnresolved : undefined,
    blocksQueued: t.status === 'review'
      ? (depsLib.dependentsOf(t.id).filter((x) => x.status === 'queued').length || undefined)
      : undefined,
    result: t.resultText ? t.resultText.slice(0, 800) : null,
  }));
  // Only the cards actually under review get a diff fetch — every other
  // status is free (no gh call), so a big board doesn't rack up gh calls.
  await Promise.all(
    state.tasks.map(async (t, i) => {
      if (t.status === 'review' && t.prUrl) rows[i].diff = await prDiffForReview(t);
    })
  );
  return rows;
}

async function buildPrompt(trigger, userMessage) {
  const c = config();
  const skills = require('./discovery').discoverSkills().map((s) => s.name);
  const lines = [
    'You are the manager of a kanban board of coding tasks. Each task card is executed by a Claude Code CLI agent.',
    'Your jobs: triage new backlog cards (assign model/effort/skills/priority), dispatch queued work, review finished tasks in "review" status against their acceptance criteria, and answer the human.',
    '',
    'Routing guidance: haiku/low for trivial or doc tasks; sonnet/medium for routine coding; opus or fable with high+ effort for complex refactors, debugging, or architecture. Only assign skills from the installed list. Be frugal: this runs on the human\'s rate-limited subscription.',
    `Review guidance: approve_task moves a card to done. reject_task retries it with your feedback (max ${c.maxRetries} retries; current retry count is in the snapshot). If a result is unverifiable or ambiguous, prefer a note asking the human rather than guessing. A review card with a PR carries a diff field (the actual code change, truncated if large) — weigh it against the acceptance criteria, not just the card's self-reported result: flag ordering/logic/safety concerns the diff shows even when the agent reports success. When a finished card's diff satisfies its acceptance criteria AND its PR checks are green, use merge_pr (not approve_task) — approving without merging still leaves the card blocking its dependents, since a done card with an unmerged PR counts as unshipped. Reserve approve_task for review cards with no open PR (nothing to merge); for a card with an open PR that isn't ready to merge yet, follow the PR checks guidance below instead of approving it.`,
    `Fixing a flawed review card: prefer followup_task over reject_task when the flaw is small and specific — a wrong condition, a missing null check, one bad line the diff shows plainly. followup_task resumes the SAME agent session (same context, same branch, same PR, no retry burned), so give it a message naming the exact file and the exact change to make, not a vague "please fix this". Reserve reject_task for when the approach itself is wrong enough that a fresh attempt beats patching the existing one (bad architecture, wrong strategy, criteria misunderstood) — that's what burns a retry and restarts the session. Never send a followup_task message that's just a natural-language "yes, looks good" or "approved" — that grants nothing and wastes a launch; use approve_task or merge_pr instead.`,
    `A card with a non-null permissionBlocked (or an error that says "blocked on permission") was stopped by the permission system, not a code failure: a plain retry repeats the exact block. Do not reject_task/retry it. Your permission ceiling is ${c.permissionCeiling}, so raising its mode via update_task only helps if a more permissive mode than the card already has still sits at or below that ceiling; otherwise leave a note asking the human to raise the card's Permissions or add an allow-rule.`,
    'PR checks: a review card with an open PR carries prChecks {base, passing, failing, pending, failed[], wrongBase}. NEVER merge_pr or approve_task while failing > 0, wrongBase is true, or pending > 0 (CI still running — wait, or note it and check back later). If prChecks is absent entirely, or present with passing+failing+pending all zero, no CI has actually reported on the PR yet — treat that as unknown, not green: do not merge_pr, wait for checks to appear. Failing tests or lint → reject_task naming the failed checks (the retry reuses the same worktree; its push updates the same PR). A failing branch-guard check (e.g. "source-must-be-staging") or wrongBase means the PR targets the wrong base branch: fix it yourself with retarget_pr (taskId + prBaseBranch) — it moves the open PR via gh pr edit --base and updates the card; a plain retry cannot move an existing PR. Once failing === 0 and pending === 0 and the base is correct, merge_pr ships it.',
    'Error tracker: the board auto-logs every operational error and block (open entries appear below with an errorId). When the human asks you to "fix errors", fix the OPERATION, never the code: permission → raise the card\'s permissionMode via update_task (within your ceiling) then run_task; wrong-base → update_task the card\'s prBaseBranch to the required base AND issue retarget_pr (it runs gh pr edit --base for you, moving the open PR); pr-flow / launch-failed → re-run, or note exactly what the human must do; pr-conflict → the human merges by hand; limit → wait, never relaunch into a cooldown; ci-failing from real tests/lint is a CODE failure — reject_task with feedback, do not "fix" it here. After handling an entry (or when it is stale/already handled), return resolve_error with its errorId. Entries also auto-resolve when the underlying run or PR later succeeds.',
    'Dependencies: a card whose deps list is non-empty stays in queued until every dep card is done (approved or PR merged) — the runner then launches it automatically. When you create a multi-card plan, chain it YOURSELF in the same response: give each dependent create_task a deps entry naming its prerequisite (the exact title of an earlier card in this actions array, or an existing card id) — never encode order as prose in the prompt. To dispatch a chain, set deps via update_task and run_task ALL of its cards at once; they will execute in order. When a review card stalled only because a prerequisite had not merged (a self-reported dependency stop, not a code failure), do NOT reject_task (that burns a retry re-hitting the same wall): update_task its deps to the prerequisite card id, then requeue_task it — requeue returns it to queued without burning a retry and it re-runs once the prerequisite ships. Fix any depsUnresolved entries the same way (update_task deps with the right card ids). A review card with blocksQueued > 0 is the critical path: review it BEFORE anything else — merge_pr it yourself when checks are green (autonomy permitting) rather than waiting on the human.',
    'Statuses: backlog, queued, running, review, done. You may only update/run non-running tasks.',
    'Groups: a card\'s group field clusters it with siblings from the same batch. Prefer finishing an in-progress group (dispatching/reviewing its remaining cards) before dispatching a fresh group; when a whole group is in review at once, review it as a batch against the shared batch intent rather than one at a time.',
    '',
    c.stylePrompt ? `Management style from the human (follow this):\n${c.stylePrompt}\n` : '',
    `Trigger for this invocation: ${trigger}`,
    userMessage ? `Message from the human: ${userMessage}` : '',
    '',
    `Installed skills: ${skills.join(', ') || '(none)'}`,
    `Board snapshot (JSON):\n${JSON.stringify(await snapshot(), null, 1)}`,
    '',
    `Open operational errors (error tracker, JSON):\n${JSON.stringify(errlog.forPrompt(20))}`,
    '',
    `Recent manager activity:\n${readLog(12).map((e) => `- [${e.kind}] ${e.text}`).join('\n') || '(none)'}`,
    '',
    'Return your decision as structured output. Use an empty actions array if nothing needs doing. Keep reply under 80 words.',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

// --- invocation (one at a time; re-trigger coalesced) ---
let busy = false;
let pending = null;
let current = null; // the live Sensei child process, when busy
let stopped = false; // this run was cancelled by the human — discard its output

// Escape hatch for a misclicked trigger: kill the in-flight run and drop any
// coalesced follow-up. The tokens already spent are gone; the point is that
// no half-baked decision gets applied.
function stopCurrent() {
  if (!current) return { error: 'the Sensei is not running' };
  stopped = true;
  pending = null;
  current.kill('SIGTERM');
  const child = current;
  setTimeout(() => {
    if (current === child) child.kill('SIGKILL');
  }, 5000);
  return { stopping: true };
}

async function invoke(trigger, userMessage = null) {
  const c = config();
  if (!c.enabled) return;
  if (require('./cooldown').active()) {
    if (userMessage) {
      mgr.chat.push({ role: 'manager', text: '⏳ Subscription limits are cooling down — I\'ll be back when they reset.', ts: new Date().toISOString() });
      saveMgr();
      broadcast({ type: 'manager', event: 'chat' });
    }
    return;
  }
  if (busy) {
    pending = { trigger, userMessage };
    return;
  }
  busy = true;
  broadcast({ type: 'manager', event: 'busy', busy: true });

  const env = subEnv();

  let prompt;
  try {
    prompt = await buildPrompt(trigger, userMessage);
  } catch (e) {
    busy = false;
    broadcast({ type: 'manager', event: 'busy', busy: false });
    log('error', `Manager prompt build failed: ${e.message}`);
    return;
  }

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(ACTION_SCHEMA),
    '--tools', '',
    '--no-session-persistence',
  ];
  const mgrModel = require('./models').effective(c.model);
  if (mgrModel && mgrModel !== 'default') args.push('--model', mgrModel);
  if (c.effort && c.effort !== 'default') args.push('--effort', c.effort);

  const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  current = child;
  stopped = false;
  require('./awake').hold(child.pid); // the Sensei is an agent too — no Mac sleep mid-review
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  let spawnErr = null;
  child.on('close', () => {
    current = null;
    busy = false;
    broadcast({ type: 'manager', event: 'busy', busy: false });
    if (stopped) {
      log('info', 'run stopped by human — output discarded');
      if (userMessage) {
        mgr.chat.push({ role: 'manager', text: '⏹ Stopped — that run was cancelled; nothing was applied.', ts: new Date().toISOString() });
        saveMgr();
        broadcast({ type: 'manager', event: 'chat' });
      }
      return;
    }
    if (!spawnErr) finishInvocation(out, err, trigger, !!userMessage);
    if (pending) {
      const p = pending;
      pending = null;
      invoke(p.trigger, p.userMessage);
    }
  });
  child.on('error', (e) => {
    spawnErr = e;
    current = null;
    busy = false;
    broadcast({ type: 'manager', event: 'busy', busy: false });
    log('error', `Manager launch failed: ${e.message}`);
  });
}

// Turn the CLI's stdout wrapper into a decision — or, when the run itself
// errored, into the right side effect. The Sensei is an agent on the same
// rate-limited subscription, so its commonest failure is a session/usage limit
// (api_error_status 429, with a human "You've hit your session limit…" string
// in `result` rather than JSON). Trip the cooldown for that — the same response
// the runner gives a limit-failed card — so all auto-flow pauses until reset,
// instead of blindly JSON.parsing the message and logging "unparsable" on every
// trigger.
function finishInvocation(out, err, trigger, isChat) {
  let wrapper;
  try {
    wrapper = JSON.parse(out);
  } catch (e) {
    log('error', `Manager output unparsable (${e.message}): ${(err || out).slice(0, 300)}`);
    return;
  }
  if (wrapper.is_error) {
    const msg = String(wrapper.result || 'the run errored');
    if (wrapper.api_error_status === 429 || require('./cooldown').detect(msg)) {
      require('./cooldown').hit(msg);
      log('note', `Paused — ${msg.replace(/\s+/g, ' ').slice(0, 160)}`);
    } else {
      log('error', `Manager run errored: ${msg.slice(0, 300)}`);
    }
    return;
  }
  let decision;
  try {
    decision = JSON.parse(wrapper.result);
  } catch (e) {
    log('error', `Manager output unparsable (${e.message}): ${(err || String(wrapper.result || out)).slice(0, 300)}`);
    return;
  }
  handleDecision(decision, trigger, isChat);
}

function handleDecision(decision, trigger, isChat) {
  const c = config();
  if (isChat || decision.reply) {
    mgr.chat.push({ role: 'manager', text: decision.reply || '(no reply)', ts: new Date().toISOString() });
    mgr.chat = mgr.chat.slice(-50);
    saveMgr();
    broadcast({ type: 'manager', event: 'chat' });
  }

  // Cards created in this decision, in order — lets a later create_task's deps
  // name an earlier sibling by title/ordinal before it has a board id.
  const batch = [];
  for (const action of decision.actions || []) {
    if (action.type === 'note') {
      log('note', `${action.reasoning}`);
      continue;
    }
    const guard = guardrailBlock(action);
    const needsApproval =
      c.autonomy === 'suggest' ||
      (c.autonomy === 'semi' && (action.type === 'approve_task' || action.type === 'reject_task' || action.type === 'followup_task' || action.type === 'merge_pr')) ||
      guard;

    if (needsApproval) {
      const s = {
        id: crypto.randomUUID(),
        action,
        trigger,
        guard: guard || null,
        createdAt: new Date().toISOString(),
      };
      mgr.suggestions.push(s);
      saveMgr();
      log('suggestion', `${describe(action)}${guard ? ` (held: ${guard})` : ''}`, { action });
      broadcast({ type: 'manager', event: 'suggestions' });
    } else {
      const res = executeAction(action, batch);
      log(res.error ? 'error' : 'action', `${describe(action)}${res.error ? ` — failed: ${res.error}` : (res.note ? ` — ${res.note}` : '')}`, { action });
    }
  }
}

function guardrailBlock(action) {
  const c = config();
  if (action.type === 'run_task' || (action.type === 'create_task' && action.autoRun) || action.type === 'reject_task' || action.type === 'followup_task' || action.type === 'requeue_task') {
    if (launchesInLastHour() >= c.maxLaunchesPerHour) return 'hourly launch cap reached';
  }
  if (action.type === 'reject_task') {
    const t = getTask(action.taskId);
    if (t && (t.retries || 0) >= c.maxRetries) return 'retry limit reached';
  }
  return null;
}

function describe(a) {
  switch (a.type) {
    case 'create_task': return `create "${a.title}" [${a.model || 'default'}/${a.effort || 'default'}]${a.autoRun ? ' + run' : ''}`;
    case 'update_task': return `update ${short(a.taskId)}: ${Object.keys(a).filter((k) => !['type', 'taskId', 'reasoning'].includes(k)).join(', ')}`;
    case 'run_task': return `run ${short(a.taskId)}`;
    case 'approve_task': return `approve ${short(a.taskId)} → done`;
    case 'reject_task': return `reject ${short(a.taskId)}: ${(a.feedback || '').slice(0, 80)}`;
    case 'followup_task': return `follow up ${short(a.taskId)}: ${(a.message || '').slice(0, 80)}`;
    case 'requeue_task': return `requeue ${short(a.taskId)} (no retry burned)`;
    case 'retarget_pr': return `retarget PR of ${short(a.taskId)} → base ${a.prBaseBranch || '?'}`;
    case 'merge_pr': return `merge PR of ${short(a.taskId)}`;
    case 'resolve_error': return `resolve error ${a.errorId || '?'}`;
    default: return a.type;
  }
}
function short(id) {
  const t = id && getTask(id);
  return t ? `"${t.title}"` : (id || '?').slice(0, 8);
}

function recordLaunch() {
  mgr.launches.push(Date.now());
  saveMgr();
}

// One manager deps array → board ids. Entries may be ids, id prefixes, exact
// titles, or ordinals into this decision's created batch — the importer's
// resolver handles all of those. Unresolvable entries land in depsUnresolved
// so the snapshot surfaces them instead of silently dropping the chain.
function resolveDeps(list, batch) {
  const ids = [];
  const unresolved = [];
  for (const d of list || []) {
    const hit = require('./importer').resolveDep(String(d), batch);
    if (hit) ids.push(hit.id);
    else unresolved.push(String(d));
  }
  return { ids, unresolved };
}

function executeAction(a, batch = []) {
  switch (a.type) {
    case 'create_task': {
      const dep = resolveDeps(a.deps, batch);
      const task = {
        id: crypto.randomUUID(),
        title: (a.title || 'Untitled').slice(0, 200),
        prompt: a.prompt || '',
        cwd: a.cwd || state.settings.defaultCwd,
        model: a.model || 'default',
        effort: a.effort || 'default',
        // The ceiling clamps only what the MANAGER chooses; when it doesn't
        // choose, the human's board default applies unclamped.
        permissionMode: a.permissionMode
          ? clampPermission(a.permissionMode)
          : (state.settings.defaultPermissionMode || 'acceptEdits'),
        skills: a.skills || [],
        skillsAuto: !!a.skillsAuto,
        agent: null,
        worktree: !!a.worktree,
        openPr: !!a.openPr,
        deps: require('./deps').sanitize(dep.ids, null),
        priority: a.priority || 0,
        acceptanceCriteria: a.acceptanceCriteria || '',
        group: a.group ? String(a.group).trim().slice(0, 60) : null,
        status: 'backlog',
        createdAt: new Date().toISOString(),
        createdBy: 'manager',
        retries: 0,
        sessionId: null, error: null, resultText: null, stats: null,
      };
      if (dep.unresolved.length) task.depsUnresolved = dep.unresolved;
      state.tasks.unshift(task);
      batch.push(task);
      save();
      broadcast({ type: 'task', task });
      if (a.autoRun) {
        recordLaunch();
        runner.startTask(task.id);
      }
      return { ok: true };
    }
    case 'update_task': {
      const t = getTask(a.taskId);
      if (!t) return { error: 'task not found' };
      if (t.status === 'running' || t.status === 'stopping') return { error: 'task is running' };
      for (const f of ['title', 'prompt', 'cwd', 'model', 'effort', 'skills', 'skillsAuto', 'worktree', 'openPr', 'prBaseBranch', 'priority', 'acceptanceCriteria', 'group']) {
        if (f in a && a[f] !== undefined) t[f] = f === 'group' && a.group ? String(a.group).trim().slice(0, 60) : a[f];
      }
      if (a.permissionMode) t.permissionMode = clampPermission(a.permissionMode);
      if (Array.isArray(a.deps)) {
        const depsLib = require('./deps');
        const dep = resolveDeps(a.deps, batch);
        const clean = depsLib.sanitize(dep.ids, t.id);
        if (depsLib.wouldCycle(t.id, clean)) return { error: 'dependency cycle' };
        t.deps = clean;
        if (dep.unresolved.length) t.depsUnresolved = dep.unresolved;
        else delete t.depsUnresolved; // the manager just resolved them
      }
      save();
      broadcast({ type: 'task', task: t });
      if (Array.isArray(a.deps)) runner.pumpQueue(); // loosened deps may free a queued card
      return { ok: true };
    }
    case 'run_task': {
      const t = getTask(a.taskId);
      if (!t) return { error: 'task not found' };
      // Already running/stopping means the desired state (work in progress)
      // already holds — a stale snapshot race, not an operational error.
      if (t.status === 'running' || t.status === 'stopping') return { ok: true, note: 'already running — no-op' };
      recordLaunch();
      return runner.startTask(t.id);
    }
    case 'approve_task': {
      const t = getTask(a.taskId);
      if (!t) return { error: 'task not found' };
      // The snapshot the Sensei acted on can be stale by the time this runs
      // (a sweep or the runner may have already moved the card) — that's
      // success or a no-op, never an operational error.
      if (t.status === 'done') return { ok: true, note: 'already done — no-op' };
      if (t.status === 'running' || t.status === 'stopping') return { ok: true, note: 'card is running — verdict skipped, can wait' };
      if (t.status !== 'review') return { error: `not in review (${t.status})` };
      t.status = 'done';
      t.managerVerdict = a.reasoning || 'approved';
      save();
      broadcast({ type: 'task', task: t });
      runner.pumpQueue(); // a shipped card may free its dependents
      return { ok: true };
    }
    // Back to queued WITHOUT burning a retry — for cards that stalled on an
    // unmet dependency or another transient wall, not a code failure. The
    // runner holds it until its deps are done, then relaunches from scratch.
    case 'requeue_task': {
      const t = getTask(a.taskId);
      if (!t) return { error: 'task not found' };
      if (t.status !== 'review' && t.status !== 'backlog') return { error: `not requeueable (${t.status})` };
      if (a.feedback) t.prompt = `${t.prompt}\n\n## Note from the manager (requeue)\n${a.feedback}`;
      t.error = null;
      t.permissionBlocked = null;
      t.status = 'queued';
      save();
      broadcast({ type: 'task', task: t });
      runner.pumpQueue();
      return { ok: true };
    }
    // Move an existing PR onto the right base branch — the fix for the
    // "opened against main, CI demands staging" class of error. gh does the
    // work; the card's prBaseBranch is set too so re-runs stay on target.
    case 'retarget_pr': {
      const t = getTask(a.taskId);
      if (!t) return { error: 'task not found' };
      if (!t.prUrl) return { error: 'card has no PR' };
      const base = String(a.prBaseBranch || t.prBaseBranch || '').trim();
      if (!base) return { error: 'no base branch given — set prBaseBranch' };
      t.prBaseBranch = base;
      save();
      broadcast({ type: 'task', task: t });
      execFile('gh', ['pr', 'edit', t.prUrl, '--base', base], { cwd: t.cwd, timeout: 60_000 }, (err, _out, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim();
          // A PR already merged or closed can't be retargeted — the goal
          // (this PR isn't sitting on the wrong base anymore) already holds.
          if (/already merged|is closed|isn't open|not open/i.test(msg)) {
            log('action', `retarget ${short(a.taskId)} → ${base} skipped — PR already merged/closed`, { action: a });
          } else {
            log('error', `retarget ${short(a.taskId)} → ${base} failed: ${msg.slice(0, 200)}`, { action: a });
          }
        } else {
          log('action', `retargeted PR of ${short(a.taskId)} → base ${base}`, { action: a });
          errlog.resolveTask(t.id, ['wrong-base'], 'sensei');
          require('./prwatch').sweep(); // re-poll checks against the new base
        }
      });
      return { ok: true }; // gh runs async; the outcome lands in the log above
    }
    // Complete the review → merged loop autonomy previously stopped short of:
    // a green, correctly-based PR gets merged instead of just approved, so
    // done-but-unmerged (prUnshipped) never gates its dependents.
    case 'merge_pr': {
      const t = getTask(a.taskId);
      if (!t) return { error: 'task not found' };
      if (t.status === 'done') return { ok: true, note: 'already merged — no-op' };
      if (t.status === 'running' || t.status === 'stopping') return { ok: true, note: 'card is running — merge skipped, can wait' };
      if (t.status !== 'review') return { error: `not in review (${t.status})` };
      if (!t.prUrl) return { ok: true, note: 'card has no PR — nothing to merge' };
      const checks = t.prChecks;
      if (!checks) return { ok: true, note: 'PR checks unknown (no CI seen on this repo) — not merging' };
      if ((checks.passing || 0) + (checks.failing || 0) + (checks.pending || 0) === 0) {
        return { ok: true, note: 'no checks have reported on this PR yet — not merging' };
      }
      if (checks.wrongBase) return { ok: true, note: 'PR targets the wrong base — not merging' };
      if (t.prBaseBranch && checks.base && t.prBaseBranch !== checks.base) return { ok: true, note: `card base ${t.prBaseBranch} != PR base ${checks.base} — not merging` };
      if (checks.failing > 0) return { ok: true, note: `${checks.failing} check(s) failing — not merging` };
      if (checks.pending > 0) return { ok: true, note: `${checks.pending} check(s) still pending — not merging` };
      require('./prflow').mergePr(t, a.reasoning || 'merged by Sensei').then((res) => {
        if (!res.ok) log('error', `merge ${short(a.taskId)} failed: ${res.error}`, { action: a });
        else log('action', `merged PR of ${short(a.taskId)}`, { action: a });
      });
      return { ok: true }; // gh runs async; the outcome lands in the log above
    }
    case 'resolve_error': {
      const e = errlog.resolve(a.errorId, 'sensei');
      // Gone or already resolved is the goal state already reached, not a failure.
      return e ? { ok: true } : { ok: true, note: 'already resolved — no-op' };
    }
    case 'reject_task': {
      const t = getTask(a.taskId);
      if (!t) return { error: 'task not found' };
      if (t.status === 'running' || t.status === 'stopping') return { ok: true, note: 'card is running — verdict skipped, can wait' };
      if (t.status !== 'review') return { error: `not in review (${t.status})` };
      t.retries = (t.retries || 0) + 1;
      t.prompt = `${t.prompt}\n\n## Reviewer feedback (retry ${t.retries})\n${a.feedback || a.reasoning}`;
      if (a.model) t.model = a.model;
      if (a.effort) t.effort = a.effort;
      t.error = null;
      save();
      recordLaunch();
      return runner.startTask(t.id);
    }
    // Cheap repair: resume the SAME session with precise feedback instead of
    // burning a full fresh run — for small, specific flaws reject_task would
    // otherwise re-run from scratch.
    case 'followup_task': {
      const t = getTask(a.taskId);
      if (!t) return { error: 'task not found' };
      if (t.status === 'running' || t.status === 'stopping') return { ok: true, note: 'card is running — follow-up skipped, can wait' };
      if (t.status === 'done') return { ok: true, note: 'already done — no-op' };
      recordLaunch();
      return runner.followUp(t.id, a.message || a.feedback || a.reasoning);
    }
    default:
      return { error: `unknown action ${a.type}` };
  }
}

// --- suggestion resolution ---

// Pure: is this suggestion still actionable given its target card's current
// state? Mirrors the status gates inside executeAction so a suggestion never
// outlives the window in which approving it would actually do anything.
function suggestionLive(s) {
  const action = s.action;
  const taskId = action && action.taskId;
  if (!taskId) return true;
  const t = getTask(taskId);
  if (!t) return false;
  switch (action.type) {
    case 'run_task':
      return t.status === 'backlog' || t.status === 'queued';
    case 'approve_task':
    case 'reject_task':
    case 'merge_pr':
    case 'followup_task':
      return t.status === 'review';
    case 'requeue_task':
      return t.status === 'review' || t.status === 'backlog';
    case 'update_task':
    case 'retarget_pr':
      return t.status !== 'running' && t.status !== 'stopping';
    default:
      return true;
  }
}

function pruneSuggestions() {
  const before = mgr.suggestions.length;
  mgr.suggestions = mgr.suggestions.filter(suggestionLive);
  const removed = before - mgr.suggestions.length;
  if (removed) {
    saveMgr();
    broadcast({ type: 'manager', event: 'suggestions' });
  }
  return removed;
}

function resolveSuggestion(sid, approve) {
  const i = mgr.suggestions.findIndex((s) => s.id === sid);
  if (i === -1) return { error: 'not found' };
  const [s] = mgr.suggestions.splice(i, 1);
  saveMgr();
  broadcast({ type: 'manager', event: 'suggestions' });
  if (!approve) {
    log('action', `human rejected: ${describe(s.action)}`);
    return { ok: true, rejected: true };
  }
  const res = executeAction(s.action);
  log(res.error ? 'error' : 'action', `human approved: ${describe(s.action)}${res.error ? ` — failed: ${res.error}` : (res.note ? ` — ${res.note}` : '')}`);
  return res;
}

function chat(message) {
  mgr.chat.push({ role: 'user', text: message, ts: new Date().toISOString() });
  mgr.chat = mgr.chat.slice(-50);
  saveMgr();
  broadcast({ type: 'manager', event: 'chat' });
  invoke('chat message from human', message);
}

// --- interval trigger ---
let intervalTimer = null;
function applyInterval() {
  clearInterval(intervalTimer);
  const min = config().triggers.intervalMin;
  if (min > 0) intervalTimer = setInterval(() => invoke('scheduled interval check'), min * 60_000);
}

function publicState() {
  pruneSuggestions();
  return {
    config: config(),
    suggestions: mgr.suggestions,
    chat: mgr.chat,
    log: readLog(40).reverse(),
    busy,
  };
}

// Fresh starts: wipe the chat thread / the activity log.
function clearChat() {
  mgr.chat = [];
  saveMgr();
  broadcast({ type: 'manager', event: 'chat' });
}

function clearLog() {
  try {
    fs.writeFileSync(MGR_LOG, '');
  } catch {}
  broadcast({ type: 'manager', event: 'log' });
}

module.exports = { config, invoke, chat, resolveSuggestion, publicState, applyInterval, clearChat, clearLog, executeAction, suggestionLive, pruneSuggestions, stopCurrent };
