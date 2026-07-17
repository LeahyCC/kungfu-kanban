import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { encrypt } from '@/lib/crypto';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';

const PROVIDERS = ['anthropic', 'github', 'openai', 'google'];

export async function GET() {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const rows = await sql()`SELECT provider, created_at FROM provider_keys WHERE user_id = ${userId}`;
    return NextResponse.json({
      providers: PROVIDERS.map((p) => ({
        provider: p,
        connected: rows.some((r) => r.provider === p),
        supported: p === 'anthropic' || p === 'github', // model adapters for the rest land next
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { provider, apiKey } = await req.json();
    if (!PROVIDERS.includes(provider)) return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
    if (typeof apiKey !== 'string' || apiKey.length < 10) {
      return NextResponse.json({ error: 'invalid key' }, { status: 400 });
    }
    const enc = encrypt(apiKey);
    await sql()`
      INSERT INTO provider_keys (user_id, provider, encrypted_key) VALUES (${userId}, ${provider}, ${enc})
      ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_key = ${enc}, created_at = now()`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const { provider } = await req.json();
    await sql()`DELETE FROM provider_keys WHERE user_id = ${userId} AND provider = ${provider}`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
