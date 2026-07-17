import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';

const STATUSES = ['backlog', 'running', 'review', 'done'];

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
        priority = COALESCE(${Number.isInteger(b.priority) ? b.priority : null}, priority),
        acceptance_criteria = COALESCE(${b.acceptanceCriteria ?? null}, acceptance_criteria),
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
    await sql()`DELETE FROM tasks WHERE id = ${id} AND user_id = ${userId} AND status != 'running'`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
