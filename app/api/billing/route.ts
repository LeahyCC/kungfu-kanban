import { NextResponse } from 'next/server';
import { ensureSchema } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { getEntitlements } from '@/lib/billing';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET() {
  try {
    await ensureSchema();
    const userId = await getUserId();
    const ent = await getEntitlements(userId);
    return NextResponse.json({ entitlements: ent, proPriceConfigured: !!process.env.STRIPE_PRICE_PRO });
  } catch (e) {
    return errorResponse(e);
  }
}
