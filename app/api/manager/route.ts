import { NextResponse } from 'next/server';
import { ensureSchema } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { managerState, saveConfig } from '@/lib/manager';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET() {
  try {
    await ensureSchema();
    const userId = await getUserId();
    return NextResponse.json(await managerState(userId));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const b = await req.json();
    const config = await saveConfig(userId, {
      enabled: !!b.enabled,
      model: b.model,
      effort: b.effort,
      autonomy: ['suggest', 'semi', 'auto'].includes(b.autonomy) ? b.autonomy : 'suggest',
      style_prompt: String(b.style_prompt ?? '').slice(0, 4000),
      on_finish: !!b.on_finish,
      on_new_card: !!b.on_new_card,
      max_retries: Math.min(5, Math.max(0, parseInt(b.max_retries, 10) || 0)),
      max_launches_per_hour: Math.min(60, Math.max(1, parseInt(b.max_launches_per_hour, 10) || 10)),
    });
    return NextResponse.json(config);
  } catch (e) {
    return errorResponse(e);
  }
}
