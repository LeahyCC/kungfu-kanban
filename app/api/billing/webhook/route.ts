import { NextResponse } from 'next/server';
import { ensureSchema, sql } from '@/lib/db';
import { billingEnabled, stripe, upsertSubscriptionFromStripe } from '@/lib/billing';
import type Stripe from 'stripe';

export const runtime = 'nodejs';

// Stripe webhook: keep the local subscriptions table in sync. Verifies the
// signature against STRIPE_WEBHOOK_SECRET; must read the raw body.
export async function POST(req: Request) {
  if (!billingEnabled()) return NextResponse.json({ error: 'billing disabled' }, { status: 400 });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET missing' }, { status: 500 });

  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(raw, sig || '', secret);
  } catch (e) {
    return NextResponse.json({ error: `signature verification failed: ${e instanceof Error ? e.message : ''}` }, { status: 400 });
  }

  try {
    await ensureSchema();
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = s.metadata?.userId || s.client_reference_id;
        if (userId && s.subscription) {
          const sub = await stripe().subscriptions.retrieve(String(s.subscription));
          await upsertSubscriptionFromStripe(sub, userId);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const evtSub = event.data.object as Stripe.Subscription;
        // Prefer metadata; fall back to mapping by stored customer id.
        let userId = evtSub.metadata?.userId || null;
        if (!userId) {
          const rows = await sql()`SELECT user_id FROM subscriptions WHERE stripe_customer_id = ${String(evtSub.customer)}`;
          userId = rows[0]?.user_id || null;
        }
        if (userId) {
          // Re-fetch the current subscription so a late or out-of-order event
          // can't overwrite newer state with a stale payload. A deleted sub
          // still retrieves (status: canceled), so this is safe for all three.
          let current: Stripe.Subscription = evtSub;
          try {
            current = await stripe().subscriptions.retrieve(evtSub.id);
          } catch {
            // If retrieval fails (e.g. hard-deleted), fall back to the payload.
          }
          await upsertSubscriptionFromStripe(current, userId);
        }
        break;
      }
      default:
        break;
    }
    return NextResponse.json({ received: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'webhook handler failed' }, { status: 500 });
  }
}
