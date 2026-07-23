#!/usr/bin/env node
/* perf-seed.js — seed an ISOLATED kungfu-kanban instance with a realistic
 * worst-case board for performance baselining.
 *
 * NEVER run this against the production server (port 4747 / data/). It is
 * meant for a scratch instance started like:
 *
 *   KFK_TEST=1 KFK_DATA_DIR=<repo>/scratch/perf-data PORT=4848 node server.js
 *
 * Usage:
 *   node scripts/perf-seed.js [--port 4848] [--count 120] [--data-dir scratch/perf-data]
 *
 * Idempotent: if the board already holds >= count cards it only (re)asserts
 * the big-transcript file and exits.
 *
 * Safety rails baked in:
 *  - disables the Manager FIRST (default config is enabled + onNewCard, which
 *    would spawn real `claude` runs for every seeded card),
 *  - disables mac notifications,
 *  - every queued card gets an unmet dep so pumpQueue can never launch it,
 *  - refuses to run if the target port answers like the production default
 *    unless --i-know is NOT needed: it simply refuses port 4747 outright.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const PORT = Number(opt('port', 4848));
const COUNT = Number(opt('count', 120));
const DATA_DIR = path.resolve(opt('data-dir', path.join(__dirname, '..', 'scratch', 'perf-data')));
const BASE = `http://127.0.0.1:${PORT}`;

if (PORT === 4747) {
  console.error('REFUSING to seed port 4747 (production). Use the isolated instance on 4848.');
  process.exit(1);
}

const BIG_TITLE = 'PERF:big-transcript';
const TRANSCRIPT_ENTRIES = 3000;

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// --- realistic prompt text, 1–4 KB -----------------------------------------
const SNIPPETS = [
  'Refactor the session store so transcripts stream instead of buffering the whole file in memory.',
  'The board rebuilds the entire DOM on every SSE event; profile and memoize the column renderers.',
  'Add retry-with-backoff to the GitHub polling loop and surface rate-limit headers in the chip.',
  'Write unit tests for the dependency cycle detection, including transitive self-reference cases.',
  'Migrate the settings modal to the new dialog component and keep keyboard focus trapped.',
  'Investigate why the archive sweep blocks the event loop on boards with 5k+ done cards.',
  'Document the worktree launch flow in CONTRIBUTING.md with a sequence diagram.',
  'Fix the drawer scroll position jumping when output events arrive while reading scrollback.',
];
const LOREM = `When the agent streams output, each chunk is parsed as newline-delimited JSON and appended to the transcript file on disk, then broadcast to every connected client over the SSE channel. The client renders an entry element per line, applies markdown conversion for assistant text, and pins the scroll position when the reader is near the bottom. Under sustained load this produces a render per event, and the layout cost grows with the number of cards on the board because the board fingerprint is a full JSON serialization of the task list. Group headers recompute their done counts by scanning the entire task array, and the dependency badge walk is linear in the number of cards per card rendered, making the overall paint quadratic in the worst case. The measurement harness exists to quantify exactly this behavior before any optimization lands. `.repeat(6);

function realisticPrompt(i) {
  const target = 1024 + (i % 4) * 768; // 1–4 KB
  let p = `## ${SNIPPETS[i % SNIPPETS.length]}\n\nContext:\n${LOREM}`;
  while (p.length < target) p += `\nAdditional note ${p.length % 97}: verify edge cases, keep the change scoped, and update tests.\n`;
  return p.slice(0, target);
}

function realisticTranscriptEntry(i) {
  const kinds = ['assistant', 'tool', 'assistant', 'tool', 'assistant', 'init'];
  const kind = kinds[i % kinds.length];
  if (kind === 'tool') {
    const tools = ['Read src/board.js', 'Edit lib/store.js', 'Bash npm test -- --grep store', 'Grep "render\\(" public/js', 'Write docs/notes.md', 'Bash git diff --stat'];
    return { kind, text: tools[i % tools.length] };
  }
  if (kind === 'init') return { kind, text: `session ${'ab'.repeat(4)}-${i} · model sonnet` };
  // assistant: a markdown-ish paragraph of plausible size
  return { kind, text: `Step ${i}: ${SNIPPETS[i % SNIPPETS.length]}\n\n${LOREM.slice(0, 400 + (i % 300))}` };
}

async function main() {
  // 0) sanity: server up?
  const cfg = await api('GET', '/api/config');
  console.log(`connected to ${BASE} (authGate=${cfg.authGate})`);

  // 1) SAFETY: neuter the manager before creating anything (defaults would
  //    spawn claude on every new card), and silence notifications.
  await api('PUT', '/api/manager/config', { enabled: false, triggers: { onNewCard: false, onFinish: false, intervalMin: 0 } });
  await api('PUT', '/api/settings', { notifyMac: false, prWatchMin: 0 });
  console.log('manager disabled, notifications off');

  let tasks = await api('GET', '/api/tasks');
  const existing = tasks.length;
  if (existing >= COUNT) {
    console.log(`board already has ${existing} cards (>= ${COUNT}) — skipping creation`);
  } else {
    // Column distribution of the COUNT cards: backlog 42%, queued 12%,
    // review 29%, done 17%. (running/stopping can't be set via API safely.)
    const plan = [];
    for (let i = 0; i < COUNT - existing; i++) {
      const g = i / (COUNT - existing);
      plan.push(g < 0.42 ? 'backlog' : g < 0.54 ? 'queued' : g < 0.83 ? 'review' : 'done');
    }

    // 2) create cards (all land in backlog first)
    const created = [];
    for (let i = 0; i < plan.length; i++) {
      const n = existing + i;
      const t = await api('POST', '/api/tasks', {
        title: `Perf card ${String(n).padStart(3, '0')} — ${SNIPPETS[n % SNIPPETS.length].slice(0, 60)}`,
        prompt: realisticPrompt(n),
        cwd: process.env.HOME,
        model: ['default', 'sonnet', 'opus', 'haiku'][n % 4],
        effort: ['default', 'medium', 'high'][n % 3],
        priority: n % 9 === 0 ? 2 : n % 5 === 0 ? 1 : 0,
        group: n % 8 === 7 ? null : `perf-group-${n % 8}`, // ~8 groups, some ungrouped
        acceptanceCriteria: n % 3 === 0 ? 'tests pass; no regressions in board render' : '',
      });
      created.push({ id: t.id, want: plan[i] });
      if ((i + 1) % 25 === 0) console.log(`created ${i + 1}/${plan.length}`);
    }

    // 3) dependency chains: ~30 cards in 6 chains of 5, drawn from the fresh
    //    backlog cards. Chained cards stay backlog; each waits on its parent.
    const backlogish = created.filter((c) => c.want === 'backlog').slice(0, 30);
    let chained = 0;
    for (let c = 0; c < 6; c++) {
      const chain = backlogish.slice(c * 5, c * 5 + 5);
      for (let k = 1; k < chain.length; k++) {
        await api('PATCH', `/api/tasks/${chain[k].id}`, { deps: [chain[k - 1].id] });
        chained++;
      }
    }
    console.log(`wired ${chained} dependency links (6 chains × 5)`);

    // 4) move cards to their target columns. Queued cards get an UNMET dep
    //    (a backlog card) so pumpQueue can never actually launch claude.
    const anchor = backlogish[0] && backlogish[0].id; // stays backlog forever
    for (const c of created) {
      if (c.want === 'backlog') continue;
      if (c.want === 'queued') {
        await api('PATCH', `/api/tasks/${c.id}`, { deps: [anchor], status: 'queued' });
      } else {
        await api('PATCH', `/api/tasks/${c.id}`, { status: c.want });
      }
    }
    console.log('columns assigned (queued cards pinned behind an unmet dep)');
  }

  // 5) the big-transcript card: find (or designate) one review card and write
  //    ~3000 transcript entries directly in runner/store's JSONL format.
  tasks = await api('GET', '/api/tasks');
  let big = tasks.find((t) => t.title.includes(BIG_TITLE));
  if (!big) {
    const review = tasks.find((t) => t.status === 'review') || tasks[0];
    await api('PATCH', `/api/tasks/${review.id}`, { title: `${BIG_TITLE} — drawer render stress card` });
    big = { ...review, title: BIG_TITLE };
  }
  const tDir = path.join(DATA_DIR, 'transcripts');
  fs.mkdirSync(tDir, { recursive: true });
  const tFile = path.join(tDir, `${big.id}.jsonl`);
  const have = fs.existsSync(tFile) ? fs.readFileSync(tFile, 'utf8').split('\n').filter(Boolean).length : 0;
  if (have >= TRANSCRIPT_ENTRIES) {
    console.log(`transcript for ${big.id} already has ${have} entries — ok`);
  } else {
    const lines = [];
    for (let i = 0; i < TRANSCRIPT_ENTRIES; i++) lines.push(JSON.stringify(realisticTranscriptEntry(i)));
    fs.writeFileSync(tFile, lines.join('\n') + '\n');
    console.log(`wrote ${TRANSCRIPT_ENTRIES} transcript entries -> ${tFile}`);
  }

  const stats = {};
  for (const t of await api('GET', '/api/tasks')) stats[t.status] = (stats[t.status] || 0) + 1;
  console.log('final column counts:', JSON.stringify(stats));
  console.log(`big transcript card id: ${big.id}`);
}

main().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
