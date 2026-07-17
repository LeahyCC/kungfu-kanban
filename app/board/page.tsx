'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Task = {
  id: string;
  title: string;
  prompt: string;
  model: string;
  effort: string;
  priority: number;
  acceptance_criteria: string;
  status: string;
  result_text: string | null;
  error: string | null;
  stats: { model?: string; inputTokens?: number; outputTokens?: number } | null;
};

const COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'running', label: 'Running' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];
const MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

export default function BoardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    if (!res.ok) {
      setBanner(data.error || 'Failed to load tasks');
      return;
    }
    setBanner(null);
    setTasks(data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while anything is running
  useEffect(() => {
    const anyRunning = tasks.some((t) => t.status === 'running');
    if (anyRunning && !pollRef.current) {
      pollRef.current = setInterval(load, 3000);
    } else if (!anyRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [tasks, load]);

  const runTask = async (t: Task) => {
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: 'running' } : x)));
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

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {banner && <div className="banner">{banner}</div>}
      <div className="toolbar">
        <span className="sub">{tasks.length} tasks</span>
        <button className="primary" onClick={() => setEditing('new')}>+ New task</button>
      </div>
      <div className="board">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.key);
          return (
            <div className="column" key={col.key}>
              <div className="col-head"><span>{col.label}</span><span>{colTasks.length}</span></div>
              <div className="col-body">
                {!colTasks.length && <div className="empty-col">—</div>}
                {colTasks.map((t) => (
                  <div className="card" key={t.id} onClick={() => setViewing(t)}>
                    <div className="title">
                      {t.status === 'running' && <span className="spin" />}
                      {t.title}
                    </div>
                    <div className="badges">
                      {t.priority >= 2 && <span className="badge err">P{t.priority}</span>}
                      <span className="badge model">{t.model}</span>
                      {t.effort !== 'default' && <span className="badge effort">{t.effort}</span>}
                      {t.error && <span className="badge err">error</span>}
                      {t.stats?.outputTokens ? <span className="badge">{t.stats.outputTokens} tok</span> : null}
                    </div>
                  </div>
                ))}
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
          <div className="modal">
            <h2>{viewing.title}</h2>
            <div className="badges" style={{ marginBottom: 12 }}>
              <span className="badge model">{viewing.stats?.model || viewing.model}</span>
              <span className="badge effort">{viewing.effort}</span>
              {viewing.stats?.inputTokens != null && (
                <span className="badge">{viewing.stats.inputTokens} in / {viewing.stats.outputTokens} out</span>
              )}
            </div>
            {viewing.error && <div className="error-text">{viewing.error}</div>}
            {viewing.result_text && <div className="result">{viewing.result_text}</div>}
            {!viewing.result_text && !viewing.error && (
              <div className="result">{viewing.prompt || '(no prompt)'}</div>
            )}
            <div className="modal-actions">
              {viewing.status !== 'running' && (
                <>
                  <button className="primary" onClick={() => runTask(viewing)}>▶ Run</button>
                  <button onClick={() => { setEditing(viewing); setViewing(null); }}>Edit</button>
                  {viewing.status === 'review' && (
                    <button onClick={async () => { await patchTask(viewing.id, { status: 'done' }); setViewing(null); }}>✓ Done</button>
                  )}
                  <button
                    className="danger"
                    onClick={async () => {
                      if (!confirm('Delete this task?')) return;
                      await fetch(`/api/tasks/${viewing.id}`, { method: 'DELETE' });
                      setViewing(null);
                      await load();
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
              <button onClick={() => setViewing(null)}>Close</button>
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
      <div className="modal">
        <h2>{task ? 'Edit task' : 'New task'}</h2>
        <form onSubmit={submit}>
          <label>Title
            <input name="title" required defaultValue={task?.title || ''} placeholder="Summarize competitor pricing" />
          </label>
          <label>Prompt
            <textarea name="prompt" rows={5} required defaultValue={task?.prompt || ''} placeholder="What should the model do?" />
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
          <label>Acceptance criteria (appended to the prompt)
            <textarea name="acceptanceCriteria" rows={2} defaultValue={task?.acceptance_criteria || ''} placeholder="e.g. output a markdown table; cite sources" />
          </label>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
