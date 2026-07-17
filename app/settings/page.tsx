'use client';

import { useEffect, useState } from 'react';

type ProviderStatus = { provider: string; connected: boolean; supported: boolean };

export default function SettingsPage() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [banner, setBanner] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch('/api/keys');
    const data = await res.json();
    if (!res.ok) { setBanner(data.error || 'Failed to load'); return; }
    setBanner(null);
    setProviders(data.providers);
  };

  useEffect(() => { load(); }, []);

  const save = async (provider: string, apiKey: string) => {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey }),
    });
    const data = await res.json();
    if (!res.ok) setBanner(data.error || 'Failed to save key');
    else setBanner(null);
    await load();
  };

  const remove = async (provider: string) => {
    await fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    await load();
  };

  return (
    <main className="settings">
      <h2>Provider keys</h2>
      <p className="hint">
        Tasks run on your own provider account — paste an API key and usage bills directly to you.
        Keys are encrypted at rest (AES-256-GCM) and never shown again after saving.
      </p>
      {banner && <div className="banner" style={{ margin: '0 0 16px' }}>{banner}</div>}
      {providers.map((p) => (
        <ProviderRow key={p.provider} p={p} onSave={save} onRemove={remove} />
      ))}
    </main>
  );
}

function ProviderRow({ p, onSave, onRemove }: {
  p: ProviderStatus;
  onSave: (provider: string, key: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="provider-row">
      <span className="name">{p.provider}</span>
      {!p.supported ? (
        <span className="status-off">adapter coming soon</span>
      ) : p.connected ? (
        <>
          <span className="status-ok">✓ connected</span>
          <span style={{ flex: 1 }} />
          <button className="danger" onClick={() => onRemove(p.provider)}>Remove</button>
        </>
      ) : (
        <>
          <input
            type="password"
            placeholder="sk-ant-…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || value.length < 10}
            onClick={async () => { setBusy(true); await onSave(p.provider, value); setValue(''); setBusy(false); }}
          >
            Save
          </button>
        </>
      )}
    </div>
  );
}
