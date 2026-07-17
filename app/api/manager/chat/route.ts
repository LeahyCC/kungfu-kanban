import { NextResponse } from 'next/server';
import { ensureSchema } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { invokeManager } from '@/lib/manager';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const maxDuration = 300; // manager may run tasks inline in auto mode

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { message } = await req.json();
    if (typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'empty message' }, { status: 400 });
    }
    const reply = await invokeManager(userId, 'chat message from the human', message.trim());
    return NextResponse.json({ reply });
  } catch (e) {
    return errorResponse(e);
  }
}
