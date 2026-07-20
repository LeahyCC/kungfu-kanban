// The Manager: an LLM (via `claude -p` on the user's subscription) that
// triages, routes, dispatches, and reviews task cards. Returns structured
// actions which are executed or queued as suggestions per the autonomy level.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { state, save, getTask, writeJsonAtomic } = require('./store');
const runner = require('./runner');
const errlog = require('./errlog');
const { broadcast, subEnv } = require('./bus');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
            enum: ['create_task', 'update_task', 'run_task', 'approve_task', 'reject_task', 'requeue_task', 'retarget_pr', 'resolve_error', 'note'],
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
          errorId: { type: 'string', description: 'resolve_error: the error-tracker entry id being marked handled' },
          reasoning: { type: 'string' },
        },
        required: ['type', 'reasoning'],
      },
    },
  },
  required: ['reply', 'actions'],
};

// --- snapshot of the board for the manager prompt ---
function snapshot() {
  const depsLib = require('./deps');
  return state.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
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
}

function buildPrompt(trigger, userMessage) {
  const c = config();
  const skills = require('./discovery').discoverSkills().map((s) => s.name);
  const lines = [
    'You are the manager of a kanban board of coding tasks. Each task card is executed by a Claude Code CLI agent.',
    'Your jobs: triage new backlog cards (assign model/effort/skills/priority), dispatch queued work, review finished tasks in "review" status against their acceptance criteria, and answer the human.',
    '',
    'Routing guidance: haiku/low for trivial or doc tasks; sonnet/medium for routine coding; opus or fable with high+ effort for complex refactors, debugging, or architecture. Only assign skills from the installed list. Be frugal: this runs on the human\'s rate-limited subscription.',
    `Review guidance: approve_task moves a card to done. reject_task retries it with your feedback (max ${c.maxRetries} retries; current retry count is in the snapshot). If a result is unverifiable or ambiguous, prefer a note asking the human rather than guessing.`,
    `A card with a non-null permissionBlocked (or an error that says "blocked on permission") was stopped by the permission system, not a code failure: a plain retry repeats the exact block. Do not reject_task/retry it. Your permission ceiling is ${c.permissionCeiling}, so raising its mode via update_task only helps if a more permissive mode than the card already has still sits at or below that ceiling; otherwise leave a note asking the human to raise the card's Permissions or add an allow-rule.`,
    'PR checks: a review card with an open PR carries prChecks {base, passing, failing, pending, failed[], wrongBase}. NEVER approve_task while failing > 0, wrongBase is true, or pending > 0 (CI still running — wait). Failing tests or lint → reject_task naming the failed checks (the retry reuses the same worktree; its push updates the same PR). A failing branch-guard check (e.g. "source-must-be-staging") or wrongBase means the PR targets the wrong base branch: fix it yourself with retarget_pr (taskId + prBaseBranch) — it moves the open PR via gh pr edit --base and updates the card; a plain retry cannot move an existing PR.',
    'Error tracker: the board auto-logs every operational error and block (open entries appear below with an errorId). When the human asks you to "fix errors", fix the OPERATION, never the code: permission → raise the card\'s permissionMode via update_task (within your ceiling) then run_task; wrong-base → update_task the card\'s prBaseBranch to the required base AND issue retarget_pr (it runs gh pr edit --base for you, moving the open PR); pr-flow / launch-failed → re-run, or note exactly what the human must do; pr-conflict → the human merges by hand; limit → wait, never relaunch into a cooldown; ci-failing from real tests/lint is a CODE failure — reject_task with feedback, do not "fix" it here. After handling an entry (or when it is stale/already handled), return resolve_error with its errorId. Entries also auto-resolve when the underlying run or PR later succeeds.',
    'Dependencies: a card whose deps list is non-empty stays in queued until every dep card is done (approved or PR merged) — the runner then launches it automatically. When you create a multi-card plan, chain it YOURSELF in the same response: give each dependent create_task a deps entry naming its prerequisite (the exact title of an earlier card in this actions array, or an existing card id) — never encode order as prose in the prompt. To dispatch a chain, set deps via update_task and run_task ALL of its cards at once; they will execute in order. When a review card stalled only because a prerequisite had not merged (a self-reported dependency stop, not a code failure), do NOT reject_task (that burns a retry re-hitting the same wall): update_task its deps to the prerequisite card id, then requeue_task it — requeue returns it to queued without burning a retry and it re-runs once the prerequisite ships. Fix any depsUnresolved entries the same way (update_task deps with the right card ids). A review card with blocksQueued > 0 is the critical path: review it BEFORE anything else, and when releasing it needs the human (merging its PR), open your reply with exactly what they must click.',
    'Statuses: backlog, queued, running, review, done. You may only update/run non-running tasks.',
    '',
    c.stylePrompt ? `Management style from the human (follow this):\n${c.stylePrompt}\n` : '',
    `Trigger for this invocation: ${trigger}`,
    userMessage ? `Message from the human: ${userMessage}` : '',
    '',
    `Installed skills: ${skills.join(', ') || '(none)'}`,
    `Board snapshot (JSON):\n${JSON.stringify(snapshot(), null, 1)}`,
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

function invoke(trigger, userMessage = null) {
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

  const args = [
    '-p', buildPrompt(trigger, userMessage),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(ACTION_SCHEMA),
    '--tools', '',
    '--no-session-persistence',
  ];
  const mgrModel = require('./models').effective(c.model);
  if (mgrModel && mgrModel !== 'default') args.push('--model', mgrModel);
  if (c.effort && c.effort !== 'default') args.push('--effort', c.effort);

  const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  require('./awake').hold(child.pid); // the Sensei is an agent too — no Mac sleep mid-review
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  let spawnErr = null;
  child.on('close', () => {
    busy = false;
    broadcast({ type: 'manager', event: 'busy', busy: false });
    if (!spawnErr) finishInvocation(out, err, trigger, !!userMessage);
    if (pending) {
      const p = pending;
      pending = null;
      invoke(p.trigger, p.userMessage);
    }
  });
  child.on('error', (e) => {
    spawnErr = e;
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
      (c.autonomy === 'semi' && (action.type === 'approve_task' || action.type === 'reject_task')) ||
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
  if (action.type === 'run_task' || (action.type === 'create_task' && action.autoRun) || action.type === 'reject_task' || action.type === 'requeue_task') {
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
    case 'requeue_task': return `requeue ${short(a.taskId)} (no retry burned)`;
    case 'retarget_pr': return `retarget PR of ${short(a.taskId)} → base ${a.prBaseBranch || '?'}`;
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
      if (t.status === 'running' || t.status === 'stopping') return { error: 'already running' };
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
    default:
      return { error: `unknown action ${a.type}` };
  }
}

// --- suggestion resolution ---
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

module.exports = { config, invoke, chat, resolveSuggestion, publicState, applyInterval, clearChat, clearLog };
