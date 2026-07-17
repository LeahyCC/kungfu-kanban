// Shared task-execution path used by the run route, manager actions, and
// suggestion approvals. Plain model tasks run synchronously; repo tasks start
// detached in a sandbox and are finalized later by finalizeRepoTask (called
// from board polling and the cron sweep).
import { sql } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { MODEL_PROVIDER, runAnthropicTask, runOpenAITask, runGeminiTask } from '@/lib/providers';
import { startRepoTask, pollRepoTask } from '@/lib/sandbox-runner';

const STALE_AFTER_MS = 50 * 60 * 1000; // sandbox hard timeout is 45 min

export async function executeTask(userId: string, taskId: string): Promise<{ ok?: boolean; error?: string; task?: Record<string, unknown> }> {
  const q = sql();
  const keys = await q`SELECT provider, encrypted_key FROM provider_keys WHERE user_id = ${userId}`;
  const keyFor = (p: string) => keys.find((k) => k.provider === p);

  const pre = await q`SELECT model, repo_url FROM tasks WHERE id = ${taskId} AND user_id = ${userId}`;
  if (!pre.length) return { error: 'not found' };
  const provider = MODEL_PROVIDER[pre[0].model] ?? 'anthropic';
  if (pre[0].repo_url && provider !== 'anthropic') {
    return { error: 'Repo tasks run on the Claude Code agent — pick a Claude model for this card.' };
  }
  const providerKey = keyFor(provider);
  if (!providerKey) return { error: `No ${provider} API key on file — add one in Settings.` };

  const claimed = await q`
    UPDATE tasks SET status = 'running', error = NULL, result_text = NULL, updated_at = now()
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
      });
      const rows = await q`
        UPDATE tasks SET stats = ${JSON.stringify({ sandboxName, startedAt: Date.now() })}::jsonb, updated_at = now()
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
      UPDATE tasks SET status = 'review', error = ${msg.slice(0, 2000)}, updated_at = now()
      WHERE id = ${taskId} RETURNING *`;
    return { ok: true, task: rows[0] };
  }
}

// Check a running repo task's sandbox; finalize the task if the runner is done.
// Returns true when the task reached 'review'.
export async function finalizeRepoTask(userId: string, task: Record<string, unknown>): Promise<boolean> {
  const q = sql();
  const stats = (task.stats || {}) as { sandboxName?: string; startedAt?: number };
  if (!stats.sandboxName) return false;

  try {
    const result = await pollRepoTask(stats.sandboxName);
    if (!result) {
      if (stats.startedAt && Date.now() - stats.startedAt > STALE_AFTER_MS) {
        await q`UPDATE tasks SET status = 'review', error = 'Sandbox run timed out (45 min limit).', updated_at = now()
          WHERE id = ${task.id as string} AND user_id = ${userId} AND status = 'running'`;
        return true;
      }
      return false;
    }
    await q`UPDATE tasks SET status = 'review',
        result_text = ${result.error ? null : result.text},
        error = ${result.error || null},
        stats = ${JSON.stringify({ branch: result.branch, prUrl: result.prUrl })}::jsonb,
        updated_at = now()
      WHERE id = ${task.id as string} AND user_id = ${userId} AND status = 'running'`;
    return true;
  } catch {
    // Sandbox gone (expired or never came up) — fail the task so it doesn't hang forever
    if (stats.startedAt && Date.now() - stats.startedAt > STALE_AFTER_MS) {
      await q`UPDATE tasks SET status = 'review', error = 'Sandbox is gone — the run likely expired.', updated_at = now()
        WHERE id = ${task.id as string} AND user_id = ${userId} AND status = 'running'`;
      return true;
    }
    return false;
  }
}
