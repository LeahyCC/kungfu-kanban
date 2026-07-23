/* Pure DOM/formatting helpers with no app dependencies. Imported everywhere. */

export const $ = (s) => document.querySelector(s);

export function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// auto-scroll only when the reader is already pinned near the bottom
export const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 60;

export function relTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// log timestamps: time-of-day today, date + time otherwise (no ambiguity after midnight)
export function fmtLogTs(ts) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString();
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

// Schedule is a normalized object from the server: {kind:'interval',hours} or
// {kind:'daily',time}. Render it for the card badge and back into the "repeat"
// input's freeform form.
export function scheduleLabel(sc) {
  if (!sc) return '';
  if (sc.kind === 'interval') return `every ${sc.hours}h`;
  if (sc.kind === 'daily') return `daily ${sc.time}`;
  return '';
}
export function scheduleToInput(sc) {
  if (!sc) return '';
  if (sc.kind === 'interval') return `${sc.hours}h`;
  if (sc.kind === 'daily') return sc.time;
  return '';
}

// generic <select> populator (task modal, settings, manager config form)
export function fillSelect(sel, opts, value) {
  sel.innerHTML = '';
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o === '' ? '(none)' : o;
    sel.appendChild(opt);
  }
  sel.value = value || opts[0] || '';
}

// trailing-edge debounce (board filter input)
export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// rAF coalescer: N calls within one frame collapse into a single flush. The
// scheduler is injectable so tests can drive it without a real frame loop.
export function createCoalescer(flush, schedule) {
  const raf = schedule || ((cb) => requestAnimationFrame(cb));
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    raf(() => { pending = false; flush(); });
  };
}

// One shared visually-hidden live region for dynamic announcements (attention
// count changes, badge updates) — created lazily from JS so index.html stays
// untouched. Uses the existing .sr-only class from style.css.
let liveRegion = null;
export function announce(msg) {
  if (typeof document === 'undefined') return;
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'sr-only';
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    (document.body || document.documentElement).appendChild(liveRegion);
  }
  liveRegion.textContent = '';
  liveRegion.textContent = msg; // clear-then-set so a repeated message re-announces
}
