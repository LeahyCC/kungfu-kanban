import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { executeAction } from '@/lib/manager';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const maxDuration = 300; // approving a run/reject suggestion executes it

export async function POST(req: Request, { params }: { params: Promise<{ sid: string }> }) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { sid } = await params;
    const { approve } = await req.json();

    const rows = await sql()`DELETE FROM manager_suggestions
      WHERE id = ${sid} AND user_id = ${userId} RETURNING action`;
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    if (!approve) {
      await sql()`INSERT INTO manager_log (user_id, kind, text) VALUES (${userId}, 'action', 'human rejected a suggestion')`;
      return NextResponse.json({ ok: true, rejected: true });
    }
    const err = await executeAction(userId, rows[0].action);
    await sql()`INSERT INTO manager_log (user_id, kind, text, action)
      VALUES (${userId}, ${err ? 'error' : 'action'}, ${`human approved suggestion${err ? ` — failed: ${err}` : ''}`}, ${JSON.stringify(rows[0].action)}::jsonb)`;
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
