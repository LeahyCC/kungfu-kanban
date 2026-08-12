/* Accent-derivation tests. The board holds itself to WCAG AA for text, so a
 * user-picked accent must not be allowed to render link text below 4.5:1 —
 * a fixed lift wasn't enough for mid-tone colours (#535d93 landed at 4.39).
 *
 * Plus the background-tone plumbing: the tone is a `data-bg` attribute and
 * nothing else, so the only thing worth guarding is that an unknown or absent
 * tone leaves the attribute off entirely (an unrecognised value would stamp a
 * selector no stylesheet matches, silently pinning the dojo). */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDom } = require('./helpers/fake-dom.js');

const { document } = installFakeDom(); // appearance.js touches document/localStorage at import

const NIGHT = { r: 0x1c, g: 0x19, b: 0x16 }; // --paper-1, night dojo
const DAY = { r: 0xfd, g: 0xfb, b: 0xf5 }; // --paper-1, day dojo

let contrast, readableInk, applyLook, TONES, DEFAULTS;
test.before(async () => {
  ({ contrast, readableInk, applyLook, TONES, DEFAULTS } = await import('../public/js/appearance.js'));
});

test('contrast: known pairs match the WCAG formula', () => {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  assert.equal(Math.round(contrast(white, black)), 21);
  assert.equal(Math.round(contrast(white, white)), 1);
});

test('readableInk: every swatch and a mid-tone custom pick clears AA on both themes', () => {
  const picks = [
    { r: 0xe0, g: 0x52, b: 0x4a }, // ember
    { r: 0xd2, g: 0xa2, b: 0x4c }, // gold
    { r: 0x7f, g: 0xb0, b: 0x8d }, // jade
    { r: 0x6f, g: 0xa3, b: 0xd4 }, // sky
    { r: 0x9b, g: 0x6f, b: 0xd4 }, // iris
    { r: 0xd4, g: 0x6f, b: 0xa3 }, // blossom
    { r: 0x53, g: 0x5d, b: 0x93 }, // the mid-tone slate that exposed the bug
    { r: 0x33, g: 0x33, b: 0x33 }, // near-black: must still lift to readable
    { r: 0xff, g: 0xff, b: 0x00 }, // pure yellow: must still deepen on paper
  ];
  for (const c of picks) {
    const night = readableInk(c, NIGHT, false);
    const day = readableInk(c, DAY, true);
    assert.ok(contrast(night, NIGHT) >= 4.5, `night ${JSON.stringify(c)} → ${contrast(night, NIGHT).toFixed(2)}`);
    assert.ok(contrast(day, DAY) >= 4.5, `day ${JSON.stringify(c)} → ${contrast(day, DAY).toFixed(2)}`);
  }
});

test('readableInk: a colour that already passes stops at the design 20% shift', () => {
  const ember = { r: 0xe0, g: 0x52, b: 0x4a };
  const ink = readableInk(ember, NIGHT, false);
  // exactly 20% toward white — no further, because 20% already clears AA
  const at20 = (c) => Math.round(c + (255 - c) * 0.2);
  assert.deepEqual(ink, { r: at20(0xe0), g: at20(0x52), b: at20(0x4a) });
});

// ---------- background tones ----------

test('applyLook: a known tone stamps data-bg, and nothing else does', () => {
  const root = document.documentElement;
  const base = { ...DEFAULTS };

  applyLook({ ...base, bg: 'graphite' });
  assert.equal(root.dataset.bg, 'graphite');

  // the dojo is the absence of a tone, not a tone named 'dojo'
  applyLook({ ...base, bg: '' });
  assert.equal(root.dataset.bg, undefined);

  // a stale or hand-edited value must not stamp an attribute no rule matches
  applyLook({ ...base, bg: 'graphite' });
  applyLook({ ...base, bg: 'chartreuse' });
  assert.equal(root.dataset.bg, undefined);
});

test('applyLook: the default look leaves the board on the dojo paper', () => {
  assert.equal(DEFAULTS.bg, '');
  applyLook({ ...DEFAULTS });
  assert.equal(document.documentElement.dataset.bg, undefined);
});

test('every tone in the picker has its tokens and its preview chip in the CSS', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  for (const [id] of TONES) {
    // the chip is drawn for every entry, the dojo's included
    assert.ok(css.includes(`.look-bg[data-tone='${id}']`), `no preview chip for '${id || 'dojo'}'`);
    if (!id) continue;
    // …but only the named tones redefine tokens, in all three blocks: the
    // theme-invariant slab, the night surface, and the day surface.
    for (const sel of [
      `[data-bg='${id}'] {`,
      `:root[data-bg='${id}']:not([data-theme='light'])`,
      `:root[data-theme='light'][data-bg='${id}']`,
    ]) {
      assert.ok(css.includes(sel), `tone '${id}' is missing "${sel}"`);
    }
  }
});
