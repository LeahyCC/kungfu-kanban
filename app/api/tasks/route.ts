import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { invokeManager } from '@/lib/manager';
import { checkCreateAllowed } from '@/lib/billing';
import { errorResponse, clampPriority } from '@/lib/api';

export const runtime = 'nodejs';
export const maxDuration = 300; // the after() new-card manager triage is an LLM call

export async function GET() {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const rows = await sql()`SELECT * FROM tasks WHERE user_id = ${userId} ORDER BY priority DESC, created_at DESC`;
    return NextResponse.json(rows);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const b = await req.json();
    const capError = await checkCreateAllowed(userId);
    if (capError) return NextResponse.json({ error: capError }, { status: 403 });
    const rows = await sql()`
      INSERT INTO tasks (user_id, title, prompt, model, effort, priority, acceptance_criteria, repo_url, base_branch)
      VALUES (${userId}, ${String(b.title || 'Untitled').slice(0, 200)}, ${b.prompt || ''},
              ${b.model || 'default'}, ${b.effort || 'default'},
              ${clampPriority(b.priority)}, ${b.acceptanceCriteria || ''},
              ${b.repoUrl || ''}, ${b.baseBranch || ''})
      RETURNING *`;
    const task = rows[0];
    after(() =>
      invokeManager(
        userId,
        `new card added to backlog by the human: "${task.title}" (id ${task.id}) — triage it (routing, priority, acceptance criteria); do not run it unless it is trivially safe`,
        null,
        'new_card',
      ),
    );
    return NextResponse.json(task);
  } catch (e) {
    return errorResponse(e);
  }
}
