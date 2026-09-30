#!/usr/bin/env node
'use strict';

/*
 * site/build.js — regenerate the marketing site's "live board replica".
 *
 * The replica in site/index.html used to be hand-copied from the real board
 * (public/index.html + public/style.css) and drifted every time the app
 * changed. Now its markup is generated from board.data.json using the app's
 * own card/column classes, and this script FAILS if any of those classes stop
 * existing in public/style.css or public/console.css — so the replica can't
 * silently fall out of sync with the product.
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
const APP_CSS = [
  path.join(REPO_ROOT, 'public', 'style.css'),
  path.join(REPO_ROOT, 'public', 'console.css'),
];

const START = '<!-- build:live-board -->';
const END = '<!-- /build:live-board -->';

// Classes the replica borrows from the real board. The app's stylesheet is the
// source of truth for how these look; if the app renames or drops one, the
// build stops and tells you to update the replica. Classes that are the site's
// own (`stripes`, `live-board`, …) are deliberately not listed here.
const SHARED_CLASSES = [
  'column', 'col-head', 'col-index', 'col-name', 'col-count', 'col-rule', 'col-body',
  'card', 'running-card', 'failed-card', 'done-card',
  'card-kicker', 'card-id', 'card-repo', 'card-elapsed', 'title', 'card-spec',
  'antenna', 'meta', 'badge', 'dep', 'failword', 'pr-link',
  'live-box', 'live-line', 'live-meta', 'ctx-bar', 'runword',
  'done-row', 'done-check', 'done-meta', 'idle-slot',
];

const COL_INDEX = { backlog: '01', queued: '02', running: '03', review: '04', done: '05' };
const EFFORT = ['', 'LOW', 'MED', 'HIGH', 'MAX'];

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}

function specLine(card) {
  if (card.spec) return card.spec;
  const effort = EFFORT[card.effort] || '';
  return [card.model, effort].filter(Boolean).join(' · ').toUpperCase();
}

function cardHtml(card, indent) {
  const variant = card.variant || '';
  const classes = ['card'];
  if (variant === 'running') classes.push('running-card');
  else if (variant === 'failed') classes.push('failed-card');
  else if (variant === 'done') classes.push('done-card');

  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);

  if (variant === 'done') {
    const meta = card.meta || [card.repo, card.pr].filter(Boolean).join(' · ');
    return [
      `${pad}<div class="${classes.join(' ')}">`,
      `${inner}<div class="done-row">`,
      `${inner}  <span class="done-check" aria-hidden="true">✓</span>`,
      `${inner}  <div class="title">${escHtml(card.title)}</div>`,
      `${inner}  <span class="done-meta">${escHtml(meta)}</span>`,
      `${inner}</div>`,
      `${pad}</div>`,
    ].join('\n');
  }

  const kicker = [`${inner}<div class="card-kicker">`];
  if (variant === 'running') kicker.push(`${inner}  <span class="antenna lit" aria-hidden="true"></span>`);
  if (card.id) kicker.push(`${inner}  <span class="card-id">${escHtml(card.id)}</span><span>·</span>`);
  kicker.push(`${inner}  <span class="card-repo">${escHtml(card.repo || '')}</span>`);
  if (card.elapsed) kicker.push(`${inner}  <span class="card-elapsed">${escHtml(card.elapsed)}</span>`);
  kicker.push(`${inner}</div>`);

  const lines = [
    `${pad}<div class="${classes.join(' ')}">`,
    ...kicker,
    `${inner}<div class="title">${escHtml(card.title)}</div>`,
    `${inner}<div class="card-spec">${escHtml(specLine(card))}</div>`,
  ];
  const meta = [];
  if (card.waits) meta.push(`<span class="badge dep">${escHtml(card.waits)}</span>`);
  if (card.pr) meta.push(`<span class="pr-link">PR ${escHtml(String(card.pr).replace(/^PR\s*/, ''))} ↗</span>`);
  if (card.failed || variant === 'failed') meta.push(`<span class="failword">✕ ${escHtml(card.failed || 'failed')}</span>`);
  if (meta.length) lines.push(`${inner}<div class="meta">${meta.join('')}</div>`);
  if (card.live) {
    const ctx = Math.max(0, Math.min(100, card.live.ctx | 0));
    lines.push(
      `${inner}<div class="live-box">`,
      `${inner}  <div class="live-line"><span class="runword">training</span></div>`,
      `${inner}  <div class="live-meta"><span>${escHtml(card.live.out || '0')} OUT</span><span style="flex:1"></span><span>CTX</span><span class="ctx-bar"><span style="width:${ctx}%"></span></span><span>${ctx}%</span></div>`,
      `${inner}</div>`,
    );
  }
  lines.push(`${pad}</div>`);
  return lines.join('\n');
}

function columnHtml(col, indent) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const cards = col.cards.map((c) => cardHtml(c, indent + 4)).join('\n');
  const idle = [];
  for (let i = 0; i < (col.idle | 0); i++) {
    idle.push(`${inner}  <div class="idle-slot">SLOT ${col.cards.length + i + 1} · IDLE</div>`);
  }
  return [
    `${pad}<div class="column" data-status="${escAttr(col.key)}">`,
    `${inner}<div class="col-head"><span class="col-index">${COL_INDEX[col.key] || ''}</span><span class="col-name">${escHtml(col.label)}</span><span class="col-count">${col.cards.length}</span></div>`,
    `${inner}<div class="col-rule"></div>`,
    `${inner}<div class="col-body">`,
    cards,
    ...idle,
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
      '  These classes are used by site/board replica but no longer exist in public/style.css or public/console.css:\n' +
      missing.map((c) => `    .${c}`).join('\n') +
      '\n  The app board changed. Update site/build.js (SHARED_CLASSES + templates) and\n' +
      '  site/style.css to match, then re-run.\n'
    );
    process.exit(1);
  }
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const cssText = APP_CSS.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
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
