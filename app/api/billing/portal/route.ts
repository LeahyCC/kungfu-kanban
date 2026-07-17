import { NextResponse } from 'next/server';
import { ensureSchema } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { billingEnabled, stripe, getSubscription } from '@/lib/billing';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    if (!billingEnabled()) return NextResponse.json({ error: 'Billing is not enabled.' }, { status: 400 });
    const sub = await getSubscription(userId);
    if (!sub?.stripe_customer_id) return NextResponse.json({ error: 'No billing account yet.' }, { status: 400 });
    const url = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
    const session = await stripe().billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${url}/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    return errorResponse(e);
  }
}
