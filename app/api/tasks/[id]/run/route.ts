import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { decrypt } from '@/lib/crypto';
import { runAnthropicTask } from '@/lib/providers';
import { runRepoTask } from '@/lib/sandbox-runner';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const maxDuration = 300; // long model runs

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { id } = await params;
    const q = sql();

    const keys = await q`SELECT provider, encrypted_key FROM provider_keys WHERE user_id = ${userId}`;
    const anthropicKey = keys.find((k) => k.provider === 'anthropic');
    const githubKey = keys.find((k) => k.provider === 'github');
    if (!anthropicKey) {
      return NextResponse.json({ error: 'No Anthropic API key on file — add one in Settings.' }, { status: 400 });
    }

    const claimed = await q`
      UPDATE tasks SET status = 'running', error = NULL, result_text = NULL, updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND status != 'running'
      RETURNING *`;
    if (!claimed.length) return NextResponse.json({ error: 'not found or already running' }, { status: 409 });
    const task = claimed[0];

    const prompt = task.acceptance_criteria
      ? `${task.prompt}\n\nAcceptance criteria:\n${task.acceptance_criteria}`
      : task.prompt;

    try {
      let resultText: string;
      let stats: Record<string, unknown>;
      if (task.repo_url) {
        if (!githubKey) {
          throw new Error('This card targets a repo — add a GitHub token in Settings first.');
        }
        const result = await runRepoTask({
          anthropicKey: decrypt(anthropicKey.encrypted_key),
          githubToken: decrypt(githubKey.encrypted_key),
          repoUrl: task.repo_url,
          baseBranch: task.base_branch,
          model: task.model,
          effort: task.effort,
          prompt,
          taskId: task.id,
          title: task.title,
        });
        resultText = result.text;
        stats = { model: result.model, branch: result.branch, prUrl: result.prUrl };
      } else {
        const result = await runAnthropicTask({
          apiKey: decrypt(anthropicKey.encrypted_key),
          model: task.model,
          effort: task.effort,
          prompt,
        });
        resultText = result.text;
        stats = {
          model: result.model,
          stopReason: result.stopReason,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
      }
      const rows = await q`
        UPDATE tasks SET status = 'review', result_text = ${resultText},
          stats = ${JSON.stringify(stats)}::jsonb, updated_at = now()
        WHERE id = ${id} RETURNING *`;
      return NextResponse.json(rows[0]);
    } catch (runErr) {
      const msg = runErr instanceof Error ? runErr.message : 'run failed';
      const rows = await q`
        UPDATE tasks SET status = 'review', error = ${msg.slice(0, 2000)}, updated_at = now()
        WHERE id = ${id} RETURNING *`;
      return NextResponse.json(rows[0]);
    }
  } catch (e) {
    return errorResponse(e);
  }
}
