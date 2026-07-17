'use client';

import { useEffect, useState } from 'react';

type Ent = {
  tier: string;
  billingEnabled: boolean;
  status: string;
  maxConcurrent: number;
  allowRepoTasks: boolean;
  allowAutoAutonomy: boolean;
  maxTasksPerDay: number;
  currentPeriodEnd: number | null;
};

export default function BillingPage() {
  const [ent, setEnt] = useState<Ent | null>(null);
  const [proConfigured, setProConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch('/api/billing');
    const data = await res.json();
    if (!res.ok) { setBanner(data.error || 'Failed to load'); return; }
    setEnt(data.entitlements);
    setProConfigured(data.proPriceConfigured);
  };

  useEffect(() => {
    load();
    const p = new URLSearchParams(window.location.search).get('checkout');
    if (p === 'success') setBanner('Thanks! Your subscription is being activated — it may take a moment to reflect.');
    if (p === 'cancelled') setBanner('Checkout cancelled.');
  }, []);

  const go = async (path: string) => {
    setBusy(true);
    const res = await fetch(path, { method: 'POST' });
    const data = await res.json();
    setBusy(false);
    if (data.url) window.location.href = data.url;
    else setBanner(data.error || 'Something went wrong');
  };

  if (!ent) return <main className="settings">{banner ? <div className="banner">{banner}</div> : <p className="hint">Loading…</p>}</main>;

  return (
    <main className="settings">
      <h2>Billing</h2>
      {!ent.billingEnabled ? (
        <p className="hint">
          Kungfu Kanban is in <strong>free beta</strong> — every feature is unlocked and nothing is billed.
          Paid plans turn on once billing is configured for this deployment.
        </p>
      ) : (
        <p className="hint">
          You are on the <strong>{ent.tier === 'pro' ? 'Pro' : 'Free'}</strong> plan
          {ent.status !== 'beta' && ent.status !== 'none' ? ` (${ent.status})` : ''}.
          {ent.currentPeriodEnd ? ` Renews ${new Date(ent.currentPeriodEnd * 1000).toLocaleDateString()}.` : ''}
        </p>
      )}
      {banner && <div className="banner" style={{ margin: '0 0 16px' }}>{banner}</div>}

      <div className="plan-grid">
        <div className={`plan ${ent.tier === 'free' ? 'current' : ''}`}>
          <h3>Free</h3>
          <ul>
            <li>1 task running at a time</li>
            <li>25 tasks/day</li>
            <li>Manager: suggest &amp; semi modes</li>
            <li>No repo (coding-agent) tasks</li>
          </ul>
          {ent.tier === 'free' && <span className="plan-tag">Current plan</span>}
        </div>
        <div className={`plan ${ent.tier === 'pro' ? 'current' : ''}`}>
          <h3>Pro</h3>
          <ul>
            <li>5 tasks running at once</li>
            <li>Unlimited tasks</li>
            <li>Manager autopilot (auto mode)</li>
            <li>Repo tasks → sandboxed agent + PR</li>
          </ul>
          {ent.tier === 'pro' ? (
            <>
              <span className="plan-tag">Current plan</span>
              {ent.billingEnabled && (
                <button disabled={busy} onClick={() => go('/api/billing/portal')} style={{ marginTop: 10 }}>Manage subscription</button>
              )}
            </>
          ) : ent.billingEnabled && proConfigured ? (
            <button className="primary" disabled={busy} onClick={() => go('/api/billing/checkout')} style={{ marginTop: 10 }}>
              Upgrade to Pro
            </button>
          ) : (
            <span className="plan-tag">Included in beta</span>
          )}
        </div>
      </div>
    </main>
  );
}
