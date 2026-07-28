/* Accent-derivation tests. The board holds itself to WCAG AA for text, so a
 * user-picked accent must not be allowed to render link text below 4.5:1 —
 * a fixed lift wasn't enough for mid-tone colours (#535d93 landed at 4.39). */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDom } = require('./helpers/fake-dom.js');

installFakeDom(); // appearance.js touches document/localStorage at import

const NIGHT = { r: 0x1c, g: 0x19, b: 0x16 }; // --paper-1, night dojo
const DAY = { r: 0xfd, g: 0xfb, b: 0xf5 }; // --paper-1, day dojo

let contrast, readableInk;
test.before(async () => {
  ({ contrast, readableInk } = await import('../public/js/appearance.js'));
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
