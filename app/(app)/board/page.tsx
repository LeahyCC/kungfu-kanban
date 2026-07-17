'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/* eslint-disable @next/next/no-img-element */

type Task = {
  id: string;
  title: string;
  prompt: string;
  model: string;
  effort: string;
  priority: number;
  acceptance_criteria: string;
  repo_url: string;
  base_branch: string;
  status: string;
  result_text: string | null;
  error: string | null;
  stats: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    branch?: string | null;
    prUrl?: string | null;
    sandboxName?: string;
  } | null;
};

const COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'running', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];
const MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku', 'gpt', 'gpt-luna', 'gemini-pro', 'gemini-flash'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const STRIPE_LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

function Stripes({ effort }: { effort: string }) {
  const n = STRIPE_LEVEL[effort];
  if (!n) return null;
  return (
    <span className="stripes" title={`effort: ${effort}`} aria-label={`effort ${effort}`}>
      {[1, 2, 3, 4].map((i) => <i key={i} className={i <= n ? 'on' : ''} />)}
    </span>
  );
}

export default function BoardPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    if (!res.ok) { setBanner(data.error || 'Failed to load tasks'); return; }
    setBanner(null);
    setTasks(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll while anything runs; running repo tasks also get their sandbox checked
  useEffect(() => {
    const anyRunning = (tasks || []).some((t) => t.status === 'running');
    if (anyRunning && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        await Promise.all(
          (tasks || [])
            .filter((t) => t.status === 'running' && t.stats?.sandboxName)
            .map((t) => fetch(`/api/tasks/${t.id}/poll`, { method: 'POST' }).catch(() => {}))
        );
        await load();
      }, 5000);
    } else if (!anyRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [tasks, load]);

  // Esc closes whichever layer is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setEditing(null); setViewing(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const runTask = async (t: Task) => {
    setTasks((prev) => (prev || []).map((x) => (x.id === t.id ? { ...x, status: 'running' } : x)));
    setViewing(null);
    const res = await fetch(`/api/tasks/${t.id}/run`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) setBanner(data.error || 'Run failed');
    await load();
  };

  const patchTask = async (id: string, body: Record<string, unknown>) => {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await load();
  };

  const onDrop = async (colKey: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/plain');
    const t = (tasks || []).find((x) => x.id === id);
    if (!t || t.status === 'running' || t.status === colKey) return;
    if (colKey === 'running') await runTask(t);
    else await patchTask(id, { status: colKey });
  };

  const list = tasks || [];

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {banner && <div className="banner" style={{ margin: '14px 20px 0' }} role="alert">{banner}</div>}
      <div className="toolbar">
        <span className="sub">{tasks === null ? 'loading…' : `${list.length} card${list.length === 1 ? '' : 's'}`}</span>
        <button className="primary" onClick={() => setEditing('new')}>+ New card</button>
      </div>

      <div className="board">
        {tasks !== null && list.length === 0 && (
          <div className="dojo-empty">
            <span className="crate">
              <img src="/icons/android-icon-144x144.png" alt="" width={110} height={110} />
            </span>
            <h3>The dojo is quiet.</h3>
            <p>Write a card, choose its model and effort, and let the student work.</p>
            <button className="primary" onClick={() => setEditing('new')}>Write the first card</button>
          </div>
        )}

        {(list.length > 0 || tasks === null) && COLUMNS.map((col) => {
          const colTasks = list.filter((t) => t.status === col.key);
          return (
            <div
              className={`column ${dragOver === col.key ? 'drag-over' : ''}`}
              data-status={col.key}
              key={col.key}
              onDragOver={(e) => { e.preventDefault(); setDragOver(col.key); }}
              onDragLeave={() => setDragOver((d) => (d === col.key ? null : d))}
              onDrop={(e) => onDrop(col.key, e)}
            >
              <div className="col-head">
                <span className="col-name">{col.label}</span>
                <span className="col-count">{colTasks.length}</span>
              </div>
              <div className="col-body">
                {!colTasks.length && <div className="empty-col">—</div>}
                {colTasks.map((t) => {
                  const running = t.status === 'running';
                  const done = t.status === 'done';
                  const failed = t.status === 'review' && !!t.error;
                  return (
                    <div
                      key={t.id}
                      className={`card ${running ? 'running-card brush' : ''} ${done ? 'done-card' : ''} ${failed ? 'failed-card' : ''}`}
                      draggable={!running}
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                      onClick={() => setViewing(t)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && setViewing(t)}
                    >
                      {done && <span className="seal card-seal">Shipped</span>}
                      <div className="title">
                        {running && <span className="antenna lit" aria-hidden />}
                        {t.title}
                      </div>
                      <div className="meta">
                        {t.priority >= 2 && <span className="prio-high" title={`Priority ${t.priority}`} aria-label="High priority" />}
                        {t.repo_url && <span className="badge">repo</span>}
                        <span className="badge model">{t.model}</span>
                        <Stripes effort={t.effort} />
                        {running && <span className="runword">running</span>}
                        {failed && <span className="failword">failed</span>}
                        {t.stats?.prUrl && (
                          <a className="pr-link" href={t.stats.prUrl} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}>
                            PR ↗
                          </a>
                        )}
                        {t.stats?.outputTokens ? <span className="badge">{t.stats.outputTokens} tok</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <TaskModal
          task={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}

      {viewing && (
        <div className="backdrop" onClick={(e) => e.target === e.currentTarget && setViewing(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={viewing.title}>
            <h2>{viewing.title}</h2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
              <span className="badge model">{viewing.stats?.model || viewing.model}</span>
              <Stripes effort={viewing.effort} />
              {viewing.stats?.inputTokens != null && (
                <span className="badge">{viewing.stats.inputTokens} in / {viewing.stats.outputTokens} out</span>
              )}
              {viewing.stats?.prUrl && (
                <a className="pr-link" href={viewing.stats.prUrl} target="_blank" rel="noreferrer">
                  View pull request ({viewing.stats.branch}) ↗
                </a>
              )}
            </div>
            {viewing.error && <div className="error-text" style={{ marginBottom: 12 }}>{viewing.error}</div>}
            {viewing.result_text && <div className="result" style={{ marginBottom: 12 }}>{viewing.result_text}</div>}
            {!viewing.result_text && !viewing.error && (
              <div className="result" style={{ marginBottom: 12 }}>{viewing.prompt || '(no prompt)'}</div>
            )}
            <div className="modal-actions">
              {viewing.status !== 'running' && (
                <>
                  <button className="primary" onClick={() => runTask(viewing)}>Run card</button>
                  <button className="ink" onClick={() => { setEditing(viewing); setViewing(null); }}>Edit</button>
                  {viewing.status === 'review' && (
                    <button onClick={async () => { await patchTask(viewing.id, { status: 'done' }); setViewing(null); }}>✓ Done</button>
                  )}
                  <button
                    className="danger"
                    onClick={async () => {
                      if (!confirm('Delete this card?')) return;
                      await fetch(`/api/tasks/${viewing.id}`, { method: 'DELETE' });
                      setViewing(null);
                      await load();
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
              <button className="ghost" onClick={() => setViewing(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function TaskModal({ task, onClose, onSaved }: { task: Task | null; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const f = new FormData(e.currentTarget);
    const body = {
      title: f.get('title'),
      prompt: f.get('prompt'),
      model: f.get('model'),
      effort: f.get('effort'),
      priority: parseInt(String(f.get('priority')), 10) || 0,
      acceptanceCriteria: f.get('acceptanceCriteria'),
      repoUrl: f.get('repoUrl'),
      baseBranch: f.get('baseBranch'),
    };
    await fetch(task ? `/api/tasks/${task.id}` : '/api/tasks', {
      method: task ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setSaving(false);
    onSaved();
  };

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={task ? 'Edit card' : 'New card'}>
        <h2>{task ? 'Edit card' : 'Write a card'}</h2>
        <form onSubmit={submit}>
          <label>Title
            <input name="title" required defaultValue={task?.title || ''} placeholder="Fix the flaky auth test" autoFocus />
          </label>
          <label>Prompt
            <textarea name="prompt" rows={5} required defaultValue={task?.prompt || ''} placeholder="What should the agent do?" />
          </label>
          <div className="row">
            <label>Model
              <select name="model" defaultValue={task?.model || 'default'}>
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label>Effort
              <select name="effort" defaultValue={task?.effort || 'default'}>
                {EFFORTS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label>Priority
              <select name="priority" defaultValue={String(task?.priority ?? 0)}>
                <option value="0">0 · low</option>
                <option value="1">1 · normal</option>
                <option value="2">2 · high</option>
                <option value="3">3 · urgent</option>
              </select>
            </label>
          </div>
          <label>Acceptance criteria (the run is judged against this)
            <textarea name="acceptanceCriteria" rows={2} defaultValue={task?.acceptance_criteria || ''} placeholder="e.g. output a markdown table; cite sources" />
          </label>
          <div className="row">
            <label style={{ flex: 2 }}>GitHub repo (optional — sandboxed coding agent, opens a PR)
              <input name="repoUrl" defaultValue={task?.repo_url || ''} placeholder="https://github.com/you/project" />
            </label>
            <label>Base branch
              <input name="baseBranch" defaultValue={task?.base_branch || ''} placeholder="(default)" />
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save card'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
