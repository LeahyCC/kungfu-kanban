// Cron sweep: finalize running repo tasks even when nobody has the board open.
import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { finalizeRepoTask } from '@/lib/run-task';
import { invokeManager } from '@/lib/manager';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    await ensureSchema();
    const rows = await sql()`SELECT * FROM tasks
      WHERE status = 'running' AND stats ? 'sandboxName' ORDER BY updated_at ASC LIMIT 10`;
    let finalized = 0;
    for (const task of rows) {
      const finished = await finalizeRepoTask(task.user_id, task);
      if (finished) {
        finalized++;
        await invokeManager(task.user_id, `task finished and awaits review: "${task.title}" (id ${task.id})`, null, 'finish');
      }
    }
    return NextResponse.json({ checked: rows.length, finalized });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'sweep failed' }, { status: 500 });
  }
}
