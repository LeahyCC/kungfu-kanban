import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { getUserId } from '@/lib/auth';
import { billingEnabled, stripe, getSubscription } from '@/lib/billing';
import { errorResponse } from '@/lib/api';

export const runtime = 'nodejs';

function baseUrl(req: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
}

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const userId = await getUserId();
    if (!billingEnabled()) return NextResponse.json({ error: 'Billing is not enabled.' }, { status: 400 });
    const priceId = process.env.STRIPE_PRICE_PRO;
    if (!priceId) return NextResponse.json({ error: 'STRIPE_PRICE_PRO is not configured.' }, { status: 400 });

    const existing = await getSubscription(userId);
    const url = baseUrl(req);
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      ...(existing?.stripe_customer_id ? { customer: existing.stripe_customer_id } : {}),
      metadata: { userId },
      subscription_data: { metadata: { userId } },
      success_url: `${url}/billing?checkout=success`,
      cancel_url: `${url}/billing?checkout=cancelled`,
    });
    // Persist the customer id early so the webhook can always map back to the user.
    if (session.customer) {
      await sql()`
        INSERT INTO subscriptions (user_id, stripe_customer_id, tier, status)
        VALUES (${userId}, ${String(session.customer)}, 'free', 'incomplete')
        ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = ${String(session.customer)}, updated_at = now()`;
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    return errorResponse(e);
  }
}
