// The Manager for the web edition: an LLM (on the tenant's own Anthropic API
// key) that triages, dispatches, and reviews task cards. Decisions come back
// as structured output and are executed or queued as suggestions per the
// tenant's autonomy level.
import Anthropic from '@anthropic-ai/sdk';
import { sql } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { executeTask } from '@/lib/run-task';

const MODEL_MAP: Record<string, string> = {
  default: 'claude-opus-4-8',
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};

export type ManagerConfig = {
  enabled: boolean;
  model: string;
  effort: string;
  autonomy: 'suggest' | 'semi' | 'auto';
  style_prompt: string;
  on_finish: boolean;
  on_new_card: boolean;
  max_retries: number;
  max_launches_per_hour: number;
};

const DEFAULTS: ManagerConfig = {
  enabled: true,
  model: 'opus',
  effort: 'medium',
  autonomy: 'suggest',
  style_prompt: '',
  on_finish: true,
  on_new_card: true,
  max_retries: 2,
  max_launches_per_hour: 10,
};

type Action = {
  type: 'create_task' | 'update_task' | 'run_task' | 'approve_task' | 'reject_task' | 'note';
  taskId?: string;
  title?: string;
  prompt?: string;
  model?: string;
  effort?: string;
  priority?: number;
  acceptanceCriteria?: string;
  repoUrl?: string;
  autoRun?: boolean;
  feedback?: string;
  reasoning: string;
};

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string', description: 'Short message to the human summarizing what you did or recommend (under 80 words).' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['create_task', 'update_task', 'run_task', 'approve_task', 'reject_task', 'note'] },
          taskId: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          model: { type: 'string', enum: ['default', 'fable', 'opus', 'sonnet', 'haiku', 'gpt', 'gpt-luna', 'gemini-pro', 'gemini-flash'] },
          effort: { type: 'string', enum: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
          priority: { type: 'integer' },
          acceptanceCriteria: { type: 'string' },
          repoUrl: { type: 'string' },
          autoRun: { type: 'boolean' },
          feedback: { type: 'string' },
          reasoning: { type: 'string' },
        },
        required: ['type', 'reasoning'],
      },
    },
  },
  required: ['reply', 'actions'],
};

export async function getConfig(userId: string): Promise<ManagerConfig> {
  const rows = await sql()`SELECT * FROM manager_config WHERE user_id = ${userId}`;
  if (!rows.length) return { ...DEFAULTS };
  const r = rows[0];
  return {
    enabled: r.enabled, model: r.model, effort: r.effort, autonomy: r.autonomy,
    style_prompt: r.style_prompt, on_finish: r.on_finish, on_new_card: r.on_new_card,
    max_retries: r.max_retries, max_launches_per_hour: r.max_launches_per_hour,
  };
}

export async function saveConfig(userId: string, c: Partial<ManagerConfig>): Promise<ManagerConfig> {
  const cur = { ...(await getConfig(userId)), ...c };
  await sql()`
    INSERT INTO manager_config (user_id, enabled, model, effort, autonomy, style_prompt, on_finish, on_new_card, max_retries, max_launches_per_hour)
    VALUES (${userId}, ${cur.enabled}, ${cur.model}, ${cur.effort}, ${cur.autonomy}, ${cur.style_prompt},
            ${cur.on_finish}, ${cur.on_new_card}, ${cur.max_retries}, ${cur.max_launches_per_hour})
    ON CONFLICT (user_id) DO UPDATE SET
      enabled = ${cur.enabled}, model = ${cur.model}, effort = ${cur.effort}, autonomy = ${cur.autonomy},
      style_prompt = ${cur.style_prompt}, on_finish = ${cur.on_finish}, on_new_card = ${cur.on_new_card},
      max_retries = ${cur.max_retries}, max_launches_per_hour = ${cur.max_launches_per_hour}`;
  return cur;
}

async function log(userId: string, kind: string, text: string, action?: Action) {
  await sql()`INSERT INTO manager_log (user_id, kind, text, action)
    VALUES (${userId}, ${kind}, ${text.slice(0, 1000)}, ${action ? JSON.stringify(action) : null}::jsonb)`;
}

function describe(a: Action): string {
  switch (a.type) {
    case 'create_task': return `create "${a.title}" [${a.model || 'default'}/${a.effort || 'default'}]${a.autoRun ? ' + run' : ''}`;
    case 'update_task': return `update task ${a.taskId?.slice(0, 8)}: ${Object.keys(a).filter((k) => !['type', 'taskId', 'reasoning'].includes(k)).join(', ')}`;
    case 'run_task': return `run task ${a.taskId?.slice(0, 8)}`;
    case 'approve_task': return `approve task ${a.taskId?.slice(0, 8)} → done`;
    case 'reject_task': return `retry task ${a.taskId?.slice(0, 8)} with feedback: ${(a.feedback || '').slice(0, 80)}`;
    default: return `note: ${a.reasoning.slice(0, 80)}`;
  }
}

async function buildPrompt(userId: string, config: ManagerConfig, trigger: string, userMessage: string | null) {
  const q = sql();
  const tasks = await q`SELECT id, title, status, priority, model, effort, retries, error,
      left(prompt, 400) AS prompt, left(coalesce(result_text, ''), 800) AS result,
      acceptance_criteria, repo_url, created_by
    FROM tasks WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 50`;
  const recent = await q`SELECT kind, text FROM manager_log WHERE user_id = ${userId} ORDER BY ts DESC LIMIT 12`;

  return [
    'You are the manager of a kanban board of AI tasks. Each card is executed by a model run (or, for cards with a repo_url, a coding agent that opens a PR).',
    'Your jobs: triage new backlog cards (assign model/effort/priority/acceptance criteria), dispatch work, review finished tasks in "review" status against their acceptance criteria, and answer the human.',
    '',
    'Routing guidance: haiku/low for trivial tasks; sonnet/medium for routine work; opus or fable with high+ effort for complex work. Cross-provider options (only if the human has that provider key connected): gpt / gpt-luna (OpenAI), gemini-pro / gemini-flash (Google). Repo tasks (repo_url set) must use a Claude model. Be frugal: runs bill to the human\'s own API keys.',
    `Review guidance: approve_task moves a card to done. reject_task retries it with your feedback (max ${config.max_retries} retries; current count is in the snapshot). If a result is unverifiable or ambiguous, prefer a note asking the human rather than guessing.`,
    'Statuses: backlog, running, review, done. Never touch running tasks.',
    config.style_prompt ? `\nManagement style from the human (follow this):\n${config.style_prompt}` : '',
    `\nTrigger for this invocation: ${trigger}`,
    userMessage ? `Message from the human: ${userMessage}` : '',
    `\nBoard snapshot (JSON):\n${JSON.stringify(tasks)}`,
    `\nRecent manager activity:\n${recent.map((e) => `- [${e.kind}] ${e.text}`).join('\n') || '(none)'}`,
    '\nReturn an empty actions array if nothing needs doing. Keep reply under 80 words.',
  ].filter(Boolean).join('\n');
}

async function launchesInLastHour(userId: string): Promise<number> {
  const rows = await sql()`SELECT count(*)::int AS n FROM manager_log
    WHERE user_id = ${userId} AND kind = 'action' AND ts > now() - interval '1 hour'
    AND action->>'type' IN ('run_task', 'reject_task', 'create_task')`;
  return rows[0]?.n ?? 0;
}

export async function invokeManager(
  userId: string,
  trigger: string,
  userMessage: string | null = null,
  kind: 'finish' | 'new_card' | 'chat' = 'chat',
): Promise<string | null> {
  try {
    const config = await getConfig(userId);
    if (!config.enabled) return null;
    if (kind === 'finish' && !config.on_finish) return null;
    if (kind === 'new_card' && !config.on_new_card) return null;

    const keys = await sql()`SELECT encrypted_key FROM provider_keys WHERE user_id = ${userId} AND provider = 'anthropic'`;
    if (!keys.length) {
      if (userMessage) return 'No Anthropic API key on file — add one in Settings so I can think.';
      return null;
    }

    const client = new Anthropic({ apiKey: decrypt(keys[0].encrypted_key) });
    const model = MODEL_MAP[config.model] ?? MODEL_MAP.opus;
    const params: Record<string, unknown> = {
      model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: await buildPrompt(userId, config, trigger, userMessage) }],
      output_config: {
        format: { type: 'json_schema', schema: DECISION_SCHEMA },
        ...(model !== 'claude-haiku-4-5' && config.effort !== 'default' ? { effort: config.effort } : {}),
      },
    };
    if (model !== 'claude-fable-5' && model !== 'claude-haiku-4-5') params.thinking = { type: 'adaptive' };

    const message = await client.messages.create(params as unknown as Parameters<typeof client.messages.create>[0]) as Anthropic.Message;
    if (message.stop_reason === 'refusal') throw new Error('manager model refused');
    const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    const decision = JSON.parse(text) as { reply: string; actions: Action[] };

    if (userMessage || decision.reply) {
      if (userMessage) await sql()`INSERT INTO manager_chat (user_id, role, text) VALUES (${userId}, 'user', ${userMessage})`;
      await sql()`INSERT INTO manager_chat (user_id, role, text) VALUES (${userId}, 'manager', ${decision.reply || '(no reply)'})`;
    }

    for (const action of decision.actions || []) {
      if (action.type === 'note') { await log(userId, 'note', action.reasoning); continue; }

      let guard: string | null = null;
      if (['run_task', 'reject_task'].includes(action.type) || (action.type === 'create_task' && action.autoRun)) {
        if ((await launchesInLastHour(userId)) >= config.max_launches_per_hour) guard = 'hourly launch cap reached';
      }
      if (action.type === 'reject_task' && action.taskId) {
        const t = await sql()`SELECT retries FROM tasks WHERE id = ${action.taskId} AND user_id = ${userId}`;
        if (t.length && t[0].retries >= config.max_retries) guard = 'retry limit reached';
      }

      const needsApproval =
        config.autonomy === 'suggest' ||
        (config.autonomy === 'semi' && ['approve_task', 'reject_task'].includes(action.type)) ||
        !!guard;

      if (needsApproval) {
        await sql()`INSERT INTO manager_suggestions (user_id, action, trigger, guard)
          VALUES (${userId}, ${JSON.stringify(action)}::jsonb, ${trigger.slice(0, 300)}, ${guard})`;
        await log(userId, 'suggestion', `${describe(action)}${guard ? ` (held: ${guard})` : ''}`, action);
      } else {
        const err = await executeAction(userId, action);
        await log(userId, err ? 'error' : 'action', `${describe(action)}${err ? ` — failed: ${err}` : ''}`, action);
      }
    }
    return decision.reply || null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'manager invocation failed';
    await log(userId, 'error', msg).catch(() => {});
    return userMessage ? `Manager error: ${msg}` : null;
  }
}

export async function executeAction(userId: string, a: Action): Promise<string | null> {
  const q = sql();
  switch (a.type) {
    case 'create_task': {
      const rows = await q`
        INSERT INTO tasks (user_id, title, prompt, model, effort, priority, acceptance_criteria, repo_url, created_by)
        VALUES (${userId}, ${(a.title || 'Untitled').slice(0, 200)}, ${a.prompt || ''}, ${a.model || 'default'},
                ${a.effort || 'default'}, ${a.priority ?? 0}, ${a.acceptanceCriteria || ''}, ${a.repoUrl || ''}, 'manager')
        RETURNING id`;
      if (a.autoRun) await executeTask(userId, rows[0].id);
      return null;
    }
    case 'update_task': {
      if (!a.taskId) return 'missing taskId';
      const rows = await q`
        UPDATE tasks SET
          title = COALESCE(${a.title ?? null}, title),
          prompt = COALESCE(${a.prompt ?? null}, prompt),
          model = COALESCE(${a.model ?? null}, model),
          effort = COALESCE(${a.effort ?? null}, effort),
          priority = COALESCE(${a.priority ?? null}, priority),
          acceptance_criteria = COALESCE(${a.acceptanceCriteria ?? null}, acceptance_criteria),
          updated_at = now()
        WHERE id = ${a.taskId} AND user_id = ${userId} AND status != 'running' RETURNING id`;
      return rows.length ? null : 'task not found or running';
    }
    case 'run_task': {
      if (!a.taskId) return 'missing taskId';
      const res = await executeTask(userId, a.taskId);
      return res.error || null;
    }
    case 'approve_task': {
      if (!a.taskId) return 'missing taskId';
      const rows = await q`UPDATE tasks SET status = 'done', updated_at = now()
        WHERE id = ${a.taskId} AND user_id = ${userId} AND status = 'review' RETURNING id`;
      return rows.length ? null : 'task not in review';
    }
    case 'reject_task': {
      if (!a.taskId) return 'missing taskId';
      const rows = await q`
        UPDATE tasks SET retries = retries + 1,
          prompt = prompt || ${'\n\n## Reviewer feedback (retry)\n' + (a.feedback || a.reasoning)},
          model = COALESCE(${a.model ?? null}, model),
          effort = COALESCE(${a.effort ?? null}, effort),
          error = NULL, updated_at = now()
        WHERE id = ${a.taskId} AND user_id = ${userId} AND status = 'review' RETURNING id`;
      if (!rows.length) return 'task not in review';
      const res = await executeTask(userId, a.taskId);
      return res.error || null;
    }
    default:
      return null;
  }
}

export async function managerState(userId: string) {
  const q = sql();
  const [config, suggestions, chat, logRows] = await Promise.all([
    getConfig(userId),
    q`SELECT id, action, trigger, guard, created_at FROM manager_suggestions WHERE user_id = ${userId} ORDER BY created_at ASC`,
    q`SELECT role, text, ts FROM manager_chat WHERE user_id = ${userId} ORDER BY ts ASC LIMIT 50`,
    q`SELECT kind, text, ts FROM manager_log WHERE user_id = ${userId} ORDER BY ts DESC LIMIT 40`,
  ]);
  return { config, suggestions, chat, log: logRows };
}
