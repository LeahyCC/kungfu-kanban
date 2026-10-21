// Reads the append-only archive (data/archive.jsonl). Kept apart from
// lib/store.js on purpose: store.js sweeps and deletes files at require time,
// and the read-only report scripts must be able to read the archive without
// loading it. Nothing here writes, and nothing runs at require time.
const fs = require('fs');

// Append order (oldest → newest); missing file and corrupt lines are skipped.
function readArchiveFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

module.exports = { readArchiveFile };
