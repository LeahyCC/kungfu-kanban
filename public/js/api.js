/* Network wrapper, styled confirm/alert dialogs, and the double-submit guard. */

import { $ } from './util.js';

// ---------- toasts: non-blocking error/status surface ----------
export function toast(msg, kind = 'error', ms = 5000) {
  let holder = $('#toasts');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'toasts';
    document.body.appendChild(holder);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  t.textContent = msg;
  holder.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Every response is inspected; errors surface as a toast unless the call site
// renders them itself ({quiet: true}). Never returns a rejected promise.
export const api = async (url, opts = {}) => {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    const error = navigator.onLine ? `network error — ${e.message || e}` : 'offline — check your connection';
    if (!opts.quiet) toast(`✕ ${error}`);
    return { error };
  }
  if (res.status === 401) { location.href = '/login'; return {}; }
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok && !data.error) data.error = `request failed (${res.status})`;
  if (data.error && !opts.quiet) toast(`✕ ${data.error}`);
  return data;
};

// ---------- styled confirm/alert (replaces native dialogs) ----------
export function showDialog({ text, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, alertOnly = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'kk-dialog';
    // resolve from the handlers themselves — some engines skip the dialog
    // 'close' event, which would leave this promise (and the UI) hanging
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      try { dlg.close(); } catch {}
      dlg.remove();
      resolve(val);
    };
    const p = document.createElement('p');
    p.textContent = text;
    const row = document.createElement('div');
    row.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.className = danger ? 'danger' : 'primary';
    ok.textContent = confirmLabel;
    ok.addEventListener('click', () => done(true));
    if (!alertOnly) {
      const no = document.createElement('button');
      no.className = 'ghost';
      no.textContent = cancelLabel;
      no.addEventListener('click', () => done(false));
      row.append(no);
    }
    row.append(ok);
    dlg.append(p, row);
    dlg.addEventListener('cancel', () => done(false)); // Escape
    dlg.addEventListener('close', () => done(false));  // any other native close
    document.body.appendChild(dlg);
    dlg.showModal();
    ok.focus();
  });
}
export const confirmDlg = (text, opts = {}) => showDialog({ text, ...opts });
export const alertDlg = (text) => showDialog({ text, alertOnly: true });

// disable a control while its async action runs (double-submit guard)
export async function withBusy(el, fn) {
  if (!el || el.disabled) return;
  el.disabled = true;
  try { return await fn(); } finally { el.disabled = false; }
}
