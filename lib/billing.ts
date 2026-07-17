// Subscription billing via Stripe. Dormant until STRIPE_SECRET_KEY is set —
// during beta (no key) every tenant gets Pro-level entitlements for free.
// When configured, the free tier is limited and Pro unlocks everything.
import Stripe from 'stripe';
import { sql } from '@/lib/db';

export type Tier = 'free' | 'pro';

export type Entitlements = {
  tier: Tier;
  billingEnabled: boolean;
  status: string; // 'beta' | Stripe subscription status
  maxConcurrent: number;
  allowRepoTasks: boolean;
  allowAutoAutonomy: boolean;
  maxTasksPerDay: number; // 0 = unlimited
  currentPeriodEnd: number | null;
};

const FREE: Omit<Entitlements, 'tier' | 'billingEnabled' | 'status' | 'currentPeriodEnd'> = {
  maxConcurrent: 1,
  allowRepoTasks: false,
  allowAutoAutonomy: false,
  maxTasksPerDay: 25,
};

const PRO: Omit<Entitlements, 'tier' | 'billingEnabled' | 'status' | 'currentPeriodEnd'> = {
  maxConcurrent: 5,
  allowRepoTasks: true,
  allowAutoAutonomy: true,
  maxTasksPerDay: 0,
};

export function billingEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

let client: Stripe | null = null;
export function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing).');
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

export async function getSubscription(userId: string) {
  const rows = await sql()`SELECT * FROM subscriptions WHERE user_id = ${userId}`;
  return rows[0] || null;
}

export async function getEntitlements(userId: string): Promise<Entitlements> {
  // Beta / self-host: no Stripe → everyone is Pro, marked as such.
  if (!billingEnabled()) {
    return { tier: 'pro', billingEnabled: false, status: 'beta', ...PRO, currentPeriodEnd: null };
  }
  const sub = await getSubscription(userId);
  const active = sub && ['active', 'trialing', 'past_due'].includes(sub.status) && sub.tier === 'pro';
  const base = active ? PRO : FREE;
  return {
    tier: active ? 'pro' : 'free',
    billingEnabled: true,
    status: sub?.status || 'none',
    ...base,
    currentPeriodEnd: sub?.current_period_end ? Number(sub.current_period_end) : null,
  };
}

// How many tasks this tenant has created today (for the free daily cap).
export async function tasksCreatedToday(userId: string): Promise<number> {
  const rows = await sql()`SELECT count(*)::int AS n FROM tasks
    WHERE user_id = ${userId} AND created_at > now() - interval '1 day'`;
  return rows[0]?.n ?? 0;
}

// How many tasks are currently running for this tenant (for maxConcurrent).
export async function tasksRunning(userId: string): Promise<number> {
  const rows = await sql()`SELECT count(*)::int AS n FROM tasks
    WHERE user_id = ${userId} AND status = 'running'`;
  return rows[0]?.n ?? 0;
}

// Gate a task launch against the tenant's entitlements. Returns an error
// string to block, or null to allow.
export async function checkLaunchAllowed(userId: string, opts: { repo: boolean }): Promise<string | null> {
  const ent = await getEntitlements(userId);
  if (opts.repo && !ent.allowRepoTasks) {
    return 'Repo (coding-agent) tasks require the Pro plan. Upgrade in Billing.';
  }
  if (ent.maxConcurrent > 0 && (await tasksRunning(userId)) >= ent.maxConcurrent) {
    return `Your plan allows ${ent.maxConcurrent} task${ent.maxConcurrent === 1 ? '' : 's'} running at once. Wait for one to finish or upgrade in Billing.`;
  }
  return null;
}

export async function upsertSubscriptionFromStripe(sub: Stripe.Subscription, userId: string) {
  const tier: Tier = sub.status === 'canceled' || sub.status === 'incomplete_expired' ? 'free' : 'pro';
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end ?? null;
  await sql()`
    INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, tier, status, current_period_end)
    VALUES (${userId}, ${sub.customer as string}, ${sub.id}, ${tier}, ${sub.status}, ${periodEnd})
    ON CONFLICT (user_id) DO UPDATE SET
      stripe_customer_id = ${sub.customer as string}, stripe_subscription_id = ${sub.id},
      tier = ${tier}, status = ${sub.status}, current_period_end = ${periodEnd}, updated_at = now()`;
}
