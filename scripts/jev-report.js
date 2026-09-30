#!/usr/bin/env node
// Compares Jev's shadow model pick (lib/jev.js) with what each card really
// ran on, what it cost and whether it ended clean. Read-only: parses the data
// files directly instead of requiring lib/store, whose boot sweep deletes
// orphan transcripts and would be a surprising side effect for a report.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.KFK_DATA_DIR || path.join(__dirname, '..', 'data');
const LADDER = ['haiku', 'sonnet', 'opus', 'fable']; // cheapest first

function rung(model) {
  const m = String(model || '').toLowerCase();
  return LADDER.find((r) => m.includes(r)) || null;
}

function readCards() {
  let live = [];
  try {
    live = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf8'));
  } catch {}
  let archived = [];
  try {
    archived = fs.readFileSync(path.join(DATA_DIR, 'archive.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {}
  return [...live, ...archived].filter((t) => t.jevRoute);
}

function fixedNum(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '';
}

// Pure so a bad stored score cannot crash the report. Old cards have no
// `model` or `confidence`; those cells stay blank.
function summarize(cards) {
  let agree = 0, cheaper = 0, pricier = 0, known = 0;
  const rows = cards.map((t) => {
    const route = t.jevRoute || {};
    const used = rung(t.modelUsed);
    const pick = route.pick;
    if (used && LADDER.includes(pick)) {
      known++;
      const d = LADDER.indexOf(pick) - LADDER.indexOf(used);
      if (d === 0) agree++;
      else if (d < 0) cheaper++;
      else pricier++;
    }
    const score = fixedNum(route.score);
    return {
      title: (t.title || '').slice(0, 50),
      jev: `${pick} (${score || '?'})`,
      confidence: fixedNum(route.confidence),
      version: route.model || '',
      used: used || t.modelUsed || '?',
      cost: t.stats?.costUsd != null ? `$${t.stats.costUsd.toFixed(2)}` : '',
      status: t.error ? 'error' : t.status,
    };
  });
  const line = `${cards.length} cards, ${known} with a known model: ` +
    `Jev agreed ${agree}, picked cheaper ${cheaper}, picked pricier ${pricier}.`;
  return { rows, line, agree, cheaper, pricier, known };
}

function main() {
  const cards = readCards();
  if (!cards.length) {
    console.log('No cards with a Jev pick yet. Is KFK_TYPESAFE_KEY set for the board server?');
    return;
  }
  const { rows, line } = summarize(cards);
  console.table(rows);
  console.log(line);
}

if (require.main === module) main();
module.exports = { summarize };
