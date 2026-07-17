import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { ensureSchema } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { executeTask } from '@/lib/run-task';
import { invokeManager } from '@/lib/manager';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const maxDuration = 300; // long model runs

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { id } = await params;
    const res = await executeTask(userId, id);
    if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
    // Let the manager review the finished run after the response is sent
    after(() => invokeManager(userId, `task finished and awaits review: "${res.task?.title}" (id ${id})`, null, 'finish'));
    return NextResponse.json(res.task);
  } catch (e) {
    return errorResponse(e);
  }
}
