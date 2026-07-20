// A card's optional `schedule` is either a repeating interval in hours or a
// daily HH:MM time. The client sends a freeform "repeat" string ("6h", "14:30");
// we normalize it to an object (or null). Passing an already-normalized object
// back through is idempotent so re-saves don't lose the parse or `lastFired`.
function parseSchedule(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw.kind ? raw : null;
  const s = String(raw).trim();
  if (!s) return null;
  const daily = s.match(/^(\d{1,2}):(\d{2})$/);
  if (daily) {
    const h = +daily[1];
    const m = +daily[2];
    if (h > 23 || m > 59) return null;
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return { kind: 'daily', time, lastFired: null };
  }
  const interval = s.match(/^(\d+(?:\.\d+)?)\s*h?$/i);
  if (interval) {
    const hours = parseFloat(interval[1]);
    if (hours > 0) return { kind: 'interval', hours, lastFired: null };
  }
  return null;
}

function localDay(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function scheduleDue(task, now) {
  const sc = task.schedule;
  if (!sc) return false;
  if (sc.kind === 'interval') {
    const last = sc.lastFired ? new Date(sc.lastFired) : new Date(task.createdAt);
    return now - last >= sc.hours * 3600 * 1000;
  }
  if (sc.kind === 'daily') {
    // Due once the target time has passed today — not only in the exact
    // minute — so a sleeping laptop catches up on wake instead of skipping.
    const [h, m] = sc.time.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (now < target) return false;
    return !sc.lastFired || localDay(new Date(sc.lastFired)) !== localDay(now);
  }
  return false;
}

module.exports = { parseSchedule, scheduleDue };
