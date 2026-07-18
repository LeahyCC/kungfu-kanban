// Rolling 5-hour usage, computed from the Claude Code session logs on this
// machine (~/.claude/projects/**/*.jsonl). That covers ALL CLI activity —
// board runs and terminal sessions — which is what the subscription's 5-hour
// window actually meters. There is no official per-plan quota API, so we
// report absolute burn; the UI turns it into a % when the user sets a budget.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const WINDOW_MS = 5 * 60 * 60 * 1000;

let cache = { at: 0, data: null };

function scan() {
  if (cache.data && Date.now() - cache.at < 120_000) return cache.data;
  const since = Date.now() - WINDOW_MS;
  const byModel = {};
  const total = { input: 0, output: 0, cacheRead: 0, turns: 0 };

  let files = [];
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const full = path.join(PROJECTS, dir);
      let entries;
      try {
        entries = fs.readdirSync(full);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(full, f);
        try {
          const st = fs.statSync(p);
          // untouched since before the window opened → nothing relevant inside
          if (st.mtimeMs >= since) files.push({ p, mtime: st.mtimeMs });
        } catch {}
      }
    }
  } catch {
    // no ~/.claude/projects — nothing to report
  }
  files = files.sort((a, b) => b.mtime - a.mtime).slice(0, 200);

  for (const { p } of files) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const u = e.message && e.message.usage;
      if (!u || !e.timestamp || Date.parse(e.timestamp) < since) continue;
      const model = ((e.message.model || 'unknown').match(/(fable|opus|sonnet|haiku)/) || ['other'])[0];
      const out = u.output_tokens || 0;
      const inp = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      total.output += out;
      total.input += inp;
      total.cacheRead += u.cache_read_input_tokens || 0;
      total.turns += 1;
      byModel[model] = (byModel[model] || 0) + out;
    }
  }

  cache = { at: Date.now(), data: { windowHours: 5, ...total, byModel } };
  return cache.data;
}

module.exports = { scan };
