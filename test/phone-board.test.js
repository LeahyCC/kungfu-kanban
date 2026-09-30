/* Phone board: one column at a time, matching the phone artboards.
   The switch lives in CSS so a resized browser shows it without a JS boot. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'console.css'), 'utf8');
const phone = css.slice(css.lastIndexOf('@media (max-width: 700px)'));

test('a phone shows only the selected column', () => {
  for (const col of ['backlog', 'queued', 'running', 'review', 'done']) {
    assert.match(phone, new RegExp(`data-phone-col="${col}"[\\s\\S]*data-status="${col}"`));
  }
  assert.match(phone, /\.board \.column \{ display: none/);
});

test('phone column chips and the card sheet are in the phone block', () => {
  assert.match(phone, /\.phone-cols \{/);
  assert.match(phone, /\.move-row \{ display: flex/);
  assert.match(phone, /html\.kk-rail-on \.sensei-rail \{[\s\S]*top: 0/);
});
