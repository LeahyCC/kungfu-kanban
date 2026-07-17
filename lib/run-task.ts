// Shared task-execution path used by the run route, manager actions, and
// suggestion approvals. Plain model tasks run synchronously; repo tasks start
// detached in a sandbox and are finalized later by finalizeRepoTask (board
// polling) and the cron sweep (which also recovers stranded plain tasks).
import { sql } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { redactSecrets } from '@/lib/api';
import { MODEL_PROVIDER, runAnthropicTask, runOpenAITask, runGeminiTask } from '@/lib/providers';
import { startRepoTask, pollRepoTask } from '@/lib/sandbox-runner';
import { checkLaunchAllowed } from '@/lib/billing';

const REPO_STALE_AFTER_MS = 50 * 60 * 1000; // sandbox hard timeout is 45 min
const PLAIN_STALE_AFTER_MS = 6 * 60 * 1000; // route budget is 5 min

export async function executeTask(userId: string, taskId: string): Promise<{ ok?: boolean; error?: string; task?: Record<string, unknown> }> {
  const q = sql();
  const keys = await q`SELECT provider, encrypted_key FROM provider_keys WHERE user_id = ${userId}`;
  const keyFor = (p: string) => keys.find((k) => k.provider === p);

  const pre = await q`SELECT model, repo_url FROM tasks WHERE id = ${taskId} AND user_id = ${userId}`;
  if (!pre.length) return { error: 'not found' };
  const isRepo = !!pre[0].repo_url;
  const provider = MODEL_PROVIDER[pre[0].model] ?? 'anthropic';
  if (isRepo && provider !== 'anthropic') {
    return { error: 'Repo tasks run on the Claude Code agent — pick a Claude model for this card.' };
  }
  const providerKey = keyFor(provider);
  if (!providerKey) return { error: `No ${provider} API key on file — add one in Settings.` };

  // Entitlement gate (repo-tasks / concurrency). No-op during free beta.
  const gate = await checkLaunchAllowed(userId, { repo: isRepo });
  if (gate) return { error: gate };

  const now = Date.now();
  const claimed = await q`
    UPDATE tasks SET status = 'running', error = NULL, result_text = NULL,
      stats = ${JSON.stringify({ startedAt: now })}::jsonb, updated_at = now()
    WHERE id = ${taskId} AND user_id = ${userId} AND status != 'running'
    RETURNING *`;
  if (!claimed.length) return { error: 'not found or already running' };
  const task = claimed[0];

  const prompt = task.acceptance_criteria
    ? `${task.prompt}\n\nAcceptance criteria:\n${task.acceptance_criteria}`
    : task.prompt;

  try {
    if (task.repo_url) {
      const githubKey = keyFor('github');
      if (!githubKey) throw new Error('This card targets a repo — add a GitHub token in Settings first.');
      const { sandboxName } = await startRepoTask({
        anthropicKey: decrypt(providerKey.encrypted_key),
        githubToken: decrypt(githubKey.encrypted_key),
        repoUrl: task.repo_url,
        baseBranch: task.base_branch,
        model: task.model,
        effort: task.effort,
        prompt,
        taskId: task.id,
        title: task.title,
        retries: task.retries || 0,
      });
      const rows = await q`
        UPDATE tasks SET stats = ${JSON.stringify({ sandboxName, startedAt: now })}::jsonb, updated_at = now()
        WHERE id = ${taskId} RETURNING *`;
      return { ok: true, task: rows[0] }; // stays 'running' until finalizeRepoTask
    }

    const runner = provider === 'openai' ? runOpenAITask : provider === 'google' ? runGeminiTask : runAnthropicTask;
    const result = await runner({
      apiKey: decrypt(providerKey.encrypted_key),
      model: task.model,
      effort: task.effort,
      prompt,
    });
    const rows = await q`
      UPDATE tasks SET status = 'review', result_text = ${result.text},
        stats = ${JSON.stringify({
          model: result.model,
          stopReason: result.stopReason,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        })}::jsonb, updated_at = now()
      WHERE id = ${taskId} RETURNING *`;
    return { ok: true, task: rows[0] };
  } catch (runErr) {
    const msg = runErr instanceof Error ? runErr.message : 'run failed';
    const rows = await q`
      UPDATE tasks SET status = 'review', error = ${redactSecrets(msg).slice(0, 2000)}, updated_at = now()
      WHERE id = ${taskId} RETURNING *`;
    return { ok: true, task: rows[0] };
  }
}

// Check a running repo task's sandbox; finalize the task if the runner is done.
// Returns true only when THIS call transitioned the row to 'review' (so the
// 'finish' manager trigger fires at most once even with poll+sweep racing).
export async function finalizeRepoTask(userId: string, task: Record<string, unknown>): Promise<boolean> {
  const q = sql();
  const stats = (task.stats || {}) as { sandboxName?: string; startedAt?: number };
  if (!stats.sandboxName) return false;
  const id = task.id as string;

  const timedOut = (): boolean => !!stats.startedAt && Date.now() - stats.startedAt > REPO_STALE_AFTER_MS;

  try {
    const result = await pollRepoTask(stats.sandboxName);
    if (!result) {
      if (timedOut()) {
        const rows = await q`UPDATE tasks SET status = 'review', error = 'Sandbox run timed out (45 min limit).', updated_at = now()
          WHERE id = ${id} AND user_id = ${userId} AND status = 'running' RETURNING id`;
        return rows.length > 0;
      }
      return false;
    }
    const rows = await q`UPDATE tasks SET status = 'review',
        result_text = ${result.error ? null : redactSecrets(result.text)},
        error = ${result.error ? redactSecrets(result.error) : null},
        stats = ${JSON.stringify({ branch: result.branch, prUrl: result.prUrl })}::jsonb,
        updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND status = 'running' RETURNING id`;
    return rows.length > 0;
  } catch {
    // Sandbox gone (expired or never came up) — fail the task if it's stale.
    if (timedOut()) {
      const rows = await q`UPDATE tasks SET status = 'review', error = 'Sandbox is gone — the run likely expired.', updated_at = now()
        WHERE id = ${id} AND user_id = ${userId} AND status = 'running' RETURNING id`;
      return rows.length > 0;
    }
    return false;
  }
}

// Recover a plain (non-repo) task stranded in 'running' past the route budget:
// the function was evicted/crashed before it could write a terminal status.
// Returns true only when THIS call transitioned it.
export async function finalizeStalePlainTask(userId: string, task: Record<string, unknown>): Promise<boolean> {
  const stats = (task.stats || {}) as { sandboxName?: string; startedAt?: number };
  if (stats.sandboxName) return false; // repo tasks are handled by finalizeRepoTask
  if (!stats.startedAt || Date.now() - stats.startedAt <= PLAIN_STALE_AFTER_MS) return false;
  const rows = await sql()`UPDATE tasks SET status = 'review', error = 'Run timed out — the model call did not return in time.', updated_at = now()
    WHERE id = ${task.id as string} AND user_id = ${userId} AND status = 'running' RETURNING id`;
  return rows.length > 0;
}
