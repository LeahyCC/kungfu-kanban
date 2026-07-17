import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';

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
    const rows = await sql()`
      INSERT INTO tasks (user_id, title, prompt, model, effort, priority, acceptance_criteria)
      VALUES (${userId}, ${String(b.title || 'Untitled').slice(0, 200)}, ${b.prompt || ''},
              ${b.model || 'default'}, ${b.effort || 'default'},
              ${Number.isInteger(b.priority) ? b.priority : 0}, ${b.acceptanceCriteria || ''})
      RETURNING *`;
    return NextResponse.json(rows[0]);
  } catch (e) {
    return errorResponse(e);
  }
}
