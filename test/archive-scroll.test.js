'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The console shell is height: 100dvh; overflow: hidden. Archive used to grow
// past that and get clipped, with no scroller of its own.
test('archive pane scrolls inside the locked shell', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'console.css'), 'utf8');
  const m = css.match(/\.archive-view\s*\{([^}]+)\}/);
  assert.ok(m, 'archive-view rule missing');
  assert.match(m[1], /min-height:\s*0/);
  assert.match(m[1], /overflow:\s*auto/);
});
