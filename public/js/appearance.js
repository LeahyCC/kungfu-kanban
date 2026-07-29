/* Per-device look & feel: theme, text size, accent colour, rainbow mode,
 * density, reduced motion. Saved in localStorage (a device preference, not
 * board state — the phone and the desktop keep their own), applied by
 * stamping CSS variables and classes on <html>. The pre-paint script in
 * index.html applies the same values before first paint, so there's no flash;
 * this module is the editor for them. */

import { $ } from './util.js';
import { paintThemeToggle } from './chips.js';

const KEY = 'kk-look';
export const DEFAULTS = { theme: 'system', scale: 100, accent: '', rainbow: false, compact: false, still: false };

// The palette offered as swatches — '' means "the dojo's own vermillion".
const SWATCHES = [
  ['', 'dojo vermillion'],
  ['#E0524A', 'ember'],
  ['#D2A24C', 'gold'],
  ['#7FB08D', 'jade'],
  ['#6FA3D4', 'sky'],
  ['#9B6FD4', 'iris'],
  ['#D46FA3', 'blossom'],
];

export function readLook() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(look) {
  try { localStorage.setItem(KEY, JSON.stringify(look)); } catch {}
}

// hex → {r,g,b}; returns null for anything that isn't #rrggbb
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// WCAG relative luminance — decides whether text on the accent is ink or paper
function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const mix = (c, t, amt) => Math.round(c + (t - c) * amt);

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// --accent-ink is the accent used as TEXT (PR links, accent copy), so a
// user-picked colour has to stay readable on the card surface. Start at the
// design's 20% shift away from the surface and keep going only as far as AA
// (4.5:1) demands — a colour that already passes keeps its intended shade.
export function readableInk(c, surface, light) {
  const target = light ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  let out = c;
  for (let amt = 0.2; amt <= 0.9; amt += 0.05) {
    out = { r: mix(c.r, target.r, amt), g: mix(c.g, target.g, amt), b: mix(c.b, target.b, amt) };
    if (contrast(out, surface) >= 4.5) break;
  }
  return out;
}

export function applyLook(look) {
  const root = document.documentElement;

  // theme: 'system' defers to the OS, anything else pins it
  const light = look.theme === 'light'
    || (look.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  if (light) root.dataset.theme = 'light';
  else delete root.dataset.theme;

  // text size — zoom scales the px-heavy stylesheet too, which a root
  // font-size alone would not (only ~a fifth of the sizes here are rem)
  root.style.zoom = look.scale && look.scale !== 100 ? look.scale / 100 : '';

  // accent: derive the whole vermillion family so hover washes, selection,
  // and on-accent text stay coherent instead of clashing with a custom hue
  const c = rgb(look.accent);
  if (c) {
    const dark = luminance(c) > 0.45; // bright accent → dark text on top
    // read the card surface from the token so this can't drift from the theme
    // (the data-theme swap above already landed, so this is the right one)
    const surface = rgb(getComputedStyle(root).getPropertyValue('--paper-1').trim())
      || (light ? { r: 253, g: 251, b: 245 } : { r: 28, g: 25, b: 22 });
    const ink = readableInk(c, surface, light);
    root.style.setProperty('--accent', look.accent);
    root.style.setProperty('--accent-ink', `rgb(${ink.r}, ${ink.g}, ${ink.b})`);
    root.style.setProperty('--accent-wash', `rgba(${c.r}, ${c.g}, ${c.b}, 0.10)`);
    root.style.setProperty('--selection-bg', `rgba(${c.r}, ${c.g}, ${c.b}, 0.30)`);
    root.style.setProperty('--on-accent', dark ? '#141210' : '#FDFBF5');
  } else {
    for (const p of ['--accent', '--accent-ink', '--accent-wash', '--selection-bg', '--on-accent']) {
      root.style.removeProperty(p);
    }
  }

  root.classList.toggle('kk-rainbow', !!look.rainbow);
  root.classList.toggle('kk-compact', !!look.compact);
  root.classList.toggle('kk-still', !!look.still);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = light ? '#F6F2E9' : '#141210';
}

// ---------- the Appearance pane ----------
// Every control applies live on input (no Save round-trip — it's local, and
// seeing the change IS the confirmation), and persists immediately.
let look = readLook();

function update(patch) {
  look = { ...look, ...patch };
  save(look);
  applyLook(look);
  paintThemeToggle();
  syncSwatches();
}

// Built ONCE. Rebuilding on every update would tear down the native colour
// input mid-drag (its `input` event fires continuously while picking), which
// is exactly what broke live colour selection — only the selected state is
// re-synced afterwards.
function paintSwatches() {
  const box = $('#lookSwatches');
  if (!box || box.dataset.built) return;
  box.dataset.built = '1';
  for (const [hex, name] of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look-sw';
    b.dataset.hex = hex;
    b.style.background = hex || 'var(--accent)';
    b.title = name;
    b.setAttribute('aria-label', `Accent: ${name}`);
    b.addEventListener('click', () => update({ accent: hex }));
    box.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'look-sw look-custom';
  custom.id = 'lookCustom';
  custom.title = 'custom colour';
  custom.setAttribute('aria-label', 'Custom accent colour');
  custom.addEventListener('input', (e) => update({ accent: e.target.value }));
  box.appendChild(custom);
  syncSwatches();
}

// Selected-state only — never touches the node the user may be dragging in.
function syncSwatches() {
  const box = $('#lookSwatches');
  if (!box || !box.dataset.built) return;
  for (const b of box.querySelectorAll('button.look-sw')) {
    const on = (b.dataset.hex || '') === (look.accent || '');
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const custom = $('#lookCustom');
  // don't write back into the picker while it's focused — that fights the drag
  if (custom && document.activeElement !== custom) custom.value = look.accent || '#E0524A';
}

// Fills the pane from the saved look — called when Settings opens.
export function renderLookPane() {
  look = readLook();
  if (!$('#lookTheme')) return;
  $('#lookTheme').value = look.theme;
  $('#lookScale').value = look.scale;
  $('#lookScaleVal').textContent = `${look.scale}%`;
  $('#lookRainbow').checked = !!look.rainbow;
  $('#lookCompact').checked = !!look.compact;
  $('#lookStill').checked = !!look.still;
  paintSwatches();
}

// The pane only exists in the real page; the module still loads (and applies
// the look) under the test harness's fake DOM, so wire defensively.
const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

on('#lookTheme', 'change', (e) => update({ theme: e.target.value }));
on('#lookScale', 'input', (e) => {
  const scale = parseInt(e.target.value, 10) || 100;
  $('#lookScaleVal').textContent = `${scale}%`;
  update({ scale });
});
on('#lookRainbow', 'change', (e) => update({ rainbow: e.target.checked }));
on('#lookCompact', 'change', (e) => update({ compact: e.target.checked }));
on('#lookStill', 'change', (e) => update({ still: e.target.checked }));
on('#lookReset', 'click', () => {
  update({ ...DEFAULTS });
  renderLookPane();
});

// The header toggle and the theme dropdown are the same setting — keep them
// in sync (chips.js writes the legacy key; this owns the stored look).
export function setTheme(theme) {
  update({ theme });
  const sel = $('#lookTheme');
  if (sel) sel.value = theme;
}

// A pinned theme must not drift when the OS flips; 'system' should follow it.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (look.theme === 'system') { applyLook(look); paintThemeToggle(); }
});

applyLook(look);
