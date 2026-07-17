'use client';

import { useEffect, useState } from 'react';

/* eslint-disable @next/next/no-img-element */

type Suggestion = { id: string; action: Record<string, unknown>; trigger: string; guard: string | null };
type ChatMsg = { role: string; text: string };
type LogEntry = { kind: string; text: string; ts: string };
type Config = {
  enabled: boolean; model: string; effort: string; autonomy: string; style_prompt: string;
  on_finish: boolean; on_new_card: boolean; max_retries: number; max_launches_per_hour: number;
};

const MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

const LADDER = [
  { level: 'suggest', name: 'Suggest', desc: 'every action waits for your approval' },
  { level: 'semi', name: 'Semi', desc: 'creates and runs cards; verdicts need your sign-off' },
  { level: 'auto', name: 'Auto', desc: 'full autopilot, inside your guardrails' },
];

function describeAction(a: Record<string, unknown>): string {
  const t = String(a.type);
  if (t === 'create_task') return `Create "${a.title}" [${a.model || 'default'}/${a.effort || 'default'}]${a.autoRun ? ' and run' : ''}`;
  if (t === 'update_task') return `Update card ${String(a.taskId || '').slice(0, 8)}`;
  if (t === 'run_task') return `Run card ${String(a.taskId || '').slice(0, 8)}`;
  if (t === 'approve_task') return `Approve card ${String(a.taskId || '').slice(0, 8)} → Done`;
  if (t === 'reject_task') return `Retry card ${String(a.taskId || '').slice(0, 8)}: ${String(a.feedback || '').slice(0, 100)}`;
  return t;
}

export default function ManagerPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [autonomy, setAutonomy] = useState<string>('suggest');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [input, setInput] = useState('');

  const load = async () => {
    const res = await fetch('/api/manager');
    const data = await res.json();
    if (!res.ok) { setBanner(data.error || 'Failed to load'); return; }
    setBanner(null);
    setConfig(data.config);
    setAutonomy(data.config.autonomy);
    setSuggestions(data.suggestions);
    setChat(data.chat);
    setLog(data.log);
  };

  useEffect(() => { load(); }, []);

  const saveConfig = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await fetch('/api/manager', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: f.get('enabled') === 'on',
        model: f.get('model'),
        effort: f.get('effort'),
        autonomy,
        style_prompt: f.get('style_prompt'),
        on_finish: f.get('on_finish') === 'on',
        on_new_card: f.get('on_new_card') === 'on',
        max_retries: f.get('max_retries'),
        max_launches_per_hour: f.get('max_launches_per_hour'),
      }),
    });
    await load();
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = input.trim();
    if (!msg || busy) return;
    setInput('');
    setBusy(true);
    setChat((c) => [...c, { role: 'user', text: msg }]);
    const res = await fetch('/api/manager/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const data = await res.json();
    if (!res.ok) setBanner(data.error || 'Chat failed');
    setBusy(false);
    await load();
  };

  const resolve = async (sid: string, approve: boolean) => {
    setBusy(true);
    const res = await fetch(`/api/manager/suggestions/${sid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve }),
    });
    const data = await res.json();
    if (!res.ok) setBanner(data.error || 'Failed');
    setBusy(false);
    await load();
  };

  if (!config) {
    return (
      <main className="settings">
        {banner ? <div className="banner" role="alert">{banner}</div> : <p className="hint">loading…</p>}
      </main>
    );
  }

  return (
    <main className="manager-grid">
      {banner && <div className="banner" style={{ gridColumn: '1 / -1' }} role="alert">{banner}</div>}

      <section className="mgr-col">
        <div className="sensei-chip">
          <span className="crate" style={{ padding: '8px 12px' }}>
            <img src="/icons/android-icon-48x48.png" alt="" width={40} height={40} />
          </span>
          <div className="who">
            <b>The Manager</b>
            <span>sensei · runs on your key</span>
          </div>
          <span className={`antenna ${busy ? 'lit' : ''}`} aria-hidden style={{ marginLeft: 'auto' }} />
        </div>

        <form onSubmit={saveConfig}>
          <label className="check-row"><input type="checkbox" name="enabled" defaultChecked={config.enabled} /> Manager enabled</label>

          <span className="field-label" style={{ marginBottom: 6, display: 'block' }}>Autonomy</span>
          <div className="ladder" role="radiogroup" aria-label="Autonomy level">
            {LADDER.map((l) => (
              <label
                key={l.level}
                className={`ladder-row ${autonomy === l.level ? 'selected' : ''}`}
                data-level={l.level}
              >
                <input
                  type="radio"
                  name="autonomy_radio"
                  value={l.level}
                  checked={autonomy === l.level}
                  onChange={() => setAutonomy(l.level)}
                />
                <span className="belt-bar" aria-hidden />
                <span className="ladder-text">
                  <b>{l.name}</b>
                  <span>{l.desc}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="row">
            <label>Model
              <select name="model" defaultValue={config.model}>{MODELS.map((m) => <option key={m}>{m}</option>)}</select>
            </label>
            <label>Effort
              <select name="effort" defaultValue={config.effort}>{EFFORTS.map((m) => <option key={m}>{m}</option>)}</select>
            </label>
          </div>
          <label>Management style (freeform instructions)
            <textarea name="style_prompt" rows={4} defaultValue={config.style_prompt}
              placeholder="e.g. prefer haiku for trivial cards; never auto-approve repo cards; keep cards small" />
          </label>
          <label className="check-row"><input type="checkbox" name="on_finish" defaultChecked={config.on_finish} /> review each card when it finishes</label>
          <label className="check-row"><input type="checkbox" name="on_new_card" defaultChecked={config.on_new_card} /> triage each new card</label>
          <div className="row">
            <label>Max launches/hour <input type="number" name="max_launches_per_hour" min={1} max={60} defaultValue={config.max_launches_per_hour} /></label>
            <label>Max retries/card <input type="number" name="max_retries" min={0} max={5} defaultValue={config.max_retries} /></label>
          </div>
          <button type="submit" className="ink">Save settings</button>
        </form>
      </section>

      <section className="mgr-col">
        <h2>Chat {busy && <span className="antenna lit" aria-label="Manager is thinking" />}</h2>
        <div className="mgr-chat">
          {chat.map((m, i) => <div key={i} className={`chat-msg ${m.role}`}>{m.text}</div>)}
          {!chat.length && <span className="empty-col">the sensei awaits a question.</span>}
        </div>
        <form className="mgr-chat-input" onSubmit={send}>
          <input value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. break the onboarding revamp into cards" disabled={busy}
            aria-label="Message the Manager" />
          <button className="primary" disabled={busy}>Send</button>
        </form>
        <h2>Pending suggestions</h2>
        <div className="mgr-suggestions">
          {!suggestions.length && <div className="empty-col">nothing pending</div>}
          {suggestions.map((s) => (
            <div className="suggestion" key={s.id}>
              <div className="sugg-head">{describeAction(s.action)}{s.guard ? ` ⚠ ${s.guard}` : ''}</div>
              <div className="sugg-why">{String(s.action.reasoning || '')}</div>
              <div className="sugg-actions">
                <button className="ink" disabled={busy} onClick={() => resolve(s.id, true)}>✓ Approve</button>
                <button className="ghost" disabled={busy} onClick={() => resolve(s.id, false)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mgr-col">
        <h2>Activity log</h2>
        <div className="mgr-log">
          {log.map((e, i) => (
            <div key={i} className={`log-entry ${e.kind}`}>
              {new Date(e.ts).toLocaleTimeString()} · {e.kind} · {e.text}
            </div>
          ))}
          {!log.length && <div className="empty-col">nothing has happened. yet.</div>}
        </div>
      </section>
    </main>
  );
}
