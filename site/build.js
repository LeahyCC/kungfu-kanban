#!/usr/bin/env node
'use strict';

/*
 * site/build.js — regenerate the marketing site's "live board replica".
 *
 * The replica in site/index.html used to be hand-copied from the real board
 * (public/index.html + public/style.css) and drifted every time the app
 * changed. Now its markup is generated from board.data.json using the app's
 * own card/column classes, and this script FAILS if any of those classes stop
 * existing in public/style.css — so the replica can't silently fall out of
 * sync with the product.
 *
 * The site stays fully static: this writes plain HTML into site/index.html
 * (committed), and Vercel deploys site/ as-is with no build step.
 *
 * Run: `npm run build:site`  (or `node site/build.js`)
 */

const fs = require('fs');
const path = require('path');

const SITE_DIR = __dirname;
const REPO_ROOT = path.join(SITE_DIR, '..');
const DATA_FILE = path.join(SITE_DIR, 'board.data.json');
const INDEX_FILE = path.join(SITE_DIR, 'index.html');
const APP_CSS = path.join(REPO_ROOT, 'public', 'style.css');

const START = '<!-- build:live-board -->';
const END = '<!-- /build:live-board -->';

// Classes the replica borrows from the real board. The app's stylesheet is the
// source of truth for how these look; if the app renames or drops one, the
// build stops and tells you to update the replica. Classes that are the site's
// own (`stripes`, `live-board`, …) are deliberately not listed here.
const SHARED_CLASSES = [
  'column', 'col-head', 'col-name', 'col-count', 'col-body',
  'card', 'running-card', 'brush', 'failed-card', 'done-card',
  'title', 'antenna', 'meta', 'badge', 'model',
  'prio-high', 'pr-link', 'failword', 'runword', 'seal', 'card-seal',
];

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}

function stripes(effort) {
  const n = Math.max(0, Math.min(4, effort | 0));
  let pips = '';
  for (let i = 0; i < 4; i++) pips += i < n ? '<i class="on"></i>' : '<i></i>';
  return `<span class="stripes" title="effort ${n}/4">${pips}</span>`;
}

function cardHtml(card, indent) {
  const variant = card.variant || '';
  const classes = ['card'];
  if (variant === 'running') classes.push('running-card', 'brush');
  else if (variant === 'failed') classes.push('failed-card');
  else if (variant === 'done') classes.push('done-card');

  const seal = variant === 'done' ? '<span class="seal card-seal">Shipped</span>' : '';
  const antenna = variant === 'running' ? '<span class="antenna lit" aria-hidden="true"></span>' : '';

  // meta order mirrors the app: identity (model, effort) first, then the
  // context chips (schedule, priority, PR, status word).
  const meta = [`<span class="badge model">${escHtml(card.model)}</span>`, stripes(card.effort)];
  if (card.schedule) meta.push(`<span class="badge">${escHtml(card.schedule)}</span>`);
  if (card.priority) meta.push(`<span class="prio-high" title="${escAttr(card.priority)}"></span>`);
  if (card.pr) meta.push(`<span class="pr-link">${escHtml(card.pr)}</span>`);
  if (variant === 'failed') meta.push('<span class="failword">failed</span>');
  if (variant === 'running') meta.push('<span class="runword">running</span>');

  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  return [
    `${pad}<div class="${classes.join(' ')}">`,
    `${inner}${seal}<div class="title">${antenna}${escHtml(card.title)}</div>`,
    `${inner}<div class="meta">${meta.join('')}</div>`,
    `${pad}</div>`,
  ].join('\n');
}

function columnHtml(col, indent) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const cards = col.cards.map((c) => cardHtml(c, indent + 4)).join('\n');
  return [
    `${pad}<div class="column" data-status="${escAttr(col.key)}">`,
    `${inner}<div class="col-head"><span class="col-name">${escHtml(col.label)}</span><span class="col-count">${col.cards.length}</span></div>`,
    `${inner}<div class="col-body">`,
    cards,
    `${inner}</div>`,
    `${pad}</div>`,
  ].join('\n');
}

function assertSharedClasses(cssText) {
  const missing = SHARED_CLASSES.filter((cls) => {
    // matches the class as a whole token in a selector: `.card`, `.card.done-card`,
    // `.card .title`, etc. `-` counts as a boundary so `.card` won't match `.cardigan`.
    const re = new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '(?![\\w-])');
    return !re.test(cssText);
  });
  if (missing.length) {
    console.error(
      '\n✗ Board replica drift detected.\n' +
      '  These classes are used by site/board replica but no longer exist in public/style.css:\n' +
      missing.map((c) => `    .${c}`).join('\n') +
      '\n  The app board changed. Update site/build.js (SHARED_CLASSES + templates) and\n' +
      '  site/style.css to match, then re-run.\n'
    );
    process.exit(1);
  }
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const cssText = fs.readFileSync(APP_CSS, 'utf8');
  assertSharedClasses(cssText);

  const html = fs.readFileSync(INDEX_FILE, 'utf8');
  const startIdx = html.indexOf(START);
  const endIdx = html.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(`✗ Could not find the ${START} … ${END} markers in site/index.html.`);
    process.exit(1);
  }

  // Preserve the marker indentation so the block sits neatly in the file.
  const lineStart = html.lastIndexOf('\n', startIdx) + 1;
  const markerIndent = html.slice(lineStart, startIdx).match(/^\s*/)[0];
  const colIndent = markerIndent.length;

  const columns = data.columns.map((col) => columnHtml(col, colIndent)).join('\n');
  const block = `${START}\n${columns}\n${markerIndent}${END}`;

  const next = html.slice(0, startIdx) + block + html.slice(endIdx + END.length);
  if (next === html) {
    console.log('✓ Board replica already up to date.');
    return;
  }
  fs.writeFileSync(INDEX_FILE, next);
  const cardCount = data.columns.reduce((n, c) => n + c.cards.length, 0);
  console.log(`✓ Regenerated live-board replica: ${data.columns.length} columns, ${cardCount} cards.`);
}

main();
