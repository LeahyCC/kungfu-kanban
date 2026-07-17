import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { finalizeRepoTask } from '@/lib/run-task';
import { invokeManager } from '@/lib/manager';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { id } = await params;
    const rows = await sql()`SELECT * FROM tasks WHERE id = ${id} AND user_id = ${userId} AND status = 'running'`;
    if (!rows.length) return NextResponse.json({ running: false });
    const finished = await finalizeRepoTask(userId, rows[0]);
    if (finished) {
      after(() => invokeManager(userId, `task finished and awaits review: "${rows[0].title}" (id ${id})`, null, 'finish'));
    }
    return NextResponse.json({ running: !finished });
  } catch (e) {
    return errorResponse(e);
  }
}
