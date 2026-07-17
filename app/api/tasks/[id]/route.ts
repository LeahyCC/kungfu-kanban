import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { errorResponse, clampPriority } from '@/lib/api';

export const runtime = 'nodejs';

// 'running' is intentionally NOT settable here — launching a task must go
// through /run (executeTask), which enforces the entitlement gate and stamps
// the recovery timestamp. Letting a user PATCH status='running' would strand a
// row that never launched and can never be recovered or deleted.
const STATUSES = ['backlog', 'review', 'done'];

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { id } = await params;
    const b = await req.json();
    const status = STATUSES.includes(b.status) ? b.status : null;
    const rows = await sql()`
      UPDATE tasks SET
        title = COALESCE(${b.title ?? null}, title),
        prompt = COALESCE(${b.prompt ?? null}, prompt),
        model = COALESCE(${b.model ?? null}, model),
        effort = COALESCE(${b.effort ?? null}, effort),
        priority = COALESCE(${Number.isInteger(b.priority) ? clampPriority(b.priority) : null}, priority),
        acceptance_criteria = COALESCE(${b.acceptanceCriteria ?? null}, acceptance_criteria),
        repo_url = COALESCE(${b.repoUrl ?? null}, repo_url),
        base_branch = COALESCE(${b.baseBranch ?? null}, base_branch),
        status = COALESCE(${status}, status),
        updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND status != 'running'
      RETURNING *`;
    if (!rows.length) return NextResponse.json({ error: 'not found or running' }, { status: 409 });
    return NextResponse.json(rows[0]);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { id } = await params;
    // Allow deleting a task that isn't running — plus any row wedged in
    // 'running' that never actually launched (no recovery markers in stats),
    // so a stranded phantom can always be cleaned up.
    await sql()`DELETE FROM tasks WHERE id = ${id} AND user_id = ${userId}
      AND (status != 'running'
           OR (stats->>'startedAt' IS NULL AND stats->>'sandboxName' IS NULL))`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
