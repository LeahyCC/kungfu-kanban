// Markdown → cards. Two shapes, auto-detected:
//   1. Sections: every "## Heading" becomes a card — heading is the title,
//      leading "key: value" lines are field overrides, an "### Acceptance"
//      subsection becomes acceptance criteria, the rest is the prompt.
//   2. Checklist: no "##" headings → every unchecked "- [ ] item" is a card.
// Optional frontmatter sets file-wide defaults for any card field.
// Sources: POST /api/import (paste/upload) and the data/inbox/ watch folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { state, save } = require('./store');

const MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMS = ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];

const INBOX = path.join(__dirname, '..', 'data', 'inbox');
const IMPORTED = path.join(INBOX, 'imported');
fs.mkdirSync(IMPORTED, { recursive: true });

const truthy = (v) => /^(true|yes|y|1|on)$/i.test(String(v).trim());

// Accepts one "key: value" line; returns a partial card field or null.
function parseField(key, value) {
  const k = key.toLowerCase().replace(/[\s_-]/g, '');
  const v = value.trim();
  switch (k) {
    case 'cwd': case 'dir': case 'directory': case 'repo':
      return v ? { cwd: v } : null;
    case 'model':
      return MODELS.includes(v.toLowerCase()) ? { model: v.toLowerCase() } : null;
    case 'effort':
      return EFFORTS.includes(v.toLowerCase()) ? { effort: v.toLowerCase() } : null;
    case 'permissions': case 'permissionmode': case 'perms': {
      const hit = PERMS.find((p) => p.toLowerCase() === v.toLowerCase());
      return hit ? { permissionMode: hit } : null;
    }
    case 'priority': {
      const n = parseInt(v, 10);
      return Number.isInteger(n) ? { priority: Math.max(0, Math.min(3, n)) } : null;
    }
    case 'worktree':
      return { worktree: truthy(v) };
    case 'openpr': case 'pr':
      return { openPr: truthy(v) };
    case 'agent':
      return v ? { agent: v } : null;
    case 'skills':
      return { skills: v.split(',').map((s) => s.trim()).filter(Boolean) };
    case 'acceptance': case 'acceptancecriteria': case 'criteria':
      return v ? { acceptanceCriteria: v } : null;
    case 'issue': case 'issuenumber': {
      const n = parseInt(String(v).replace(/^#/, ''), 10);
      return Number.isInteger(n) && n > 0 ? { issueNumber: n } : null;
    }
    default:
      return null;
  }
}

const FIELD_LINE = /^([A-Za-z][A-Za-z _-]{1,20}):\s*(.*)$/;

// Frontmatter (--- ... ---) → file-wide defaults + remaining text.
function splitFrontmatter(text) {
  const m = text.match(/^\s*---\n([\s\S]*?)\n---\n?/);
  if (!m) return { defaults: {}, body: text };
  const defaults = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(FIELD_LINE);
    if (kv) Object.assign(defaults, parseField(kv[1], kv[2]) || {});
  }
  return { defaults, body: text.slice(m[0].length) };
}

function parseSection(heading, lines) {
  const fields = {};
  let i = 0;
  // leading "key: value" override lines (blank lines between them are fine)
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const kv = line.match(FIELD_LINE);
    const parsed = kv && parseField(kv[1], kv[2]);
    if (!parsed) break;
    Object.assign(fields, parsed);
  }
  let rest = lines.slice(i).join('\n').trim();
  // "### Acceptance" (or "### Acceptance criteria") subsection
  const acc = rest.match(/^###\s+acceptance[^\n]*\n?([\s\S]*)$/im);
  if (acc) {
    rest = rest.slice(0, acc.index).trim();
    if (acc[1].trim()) fields.acceptanceCriteria = acc[1].trim();
  }
  return { title: heading.trim(), prompt: rest || heading.trim(), ...fields };
}

// Pure: markdown text → array of card specs. Throws nothing; empty on no match.
function parseMarkdown(text) {
  const { defaults, body } = splitFrontmatter(text || '');

  const parts = body.split(/^##\s+(?!#)/m);
  if (parts.length > 1) {
    // Section mode: parts[0] is preamble (ignored), each other part starts
    // with its heading line.
    return parts.slice(1).map((part) => {
      const lines = part.split('\n');
      return { ...defaults, ...parseSection(lines[0], lines.slice(1)) };
    }).filter((c) => c.title);
  }

  // Checklist mode
  const cards = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/);
    if (m && m[1] === ' ') cards.push({ ...defaults, title: m[2].trim(), prompt: m[2].trim() });
  }
  return cards;
}

let broadcast = () => {};
function setBroadcaster(fn) {
  broadcast = fn;
}

// Create real backlog cards from parsed specs. Returns the created tasks.
function createCards(specs) {
  const created = [];
  for (const c of specs) {
    const task = {
      id: crypto.randomUUID(),
      title: c.title.slice(0, 200),
      prompt: c.prompt || c.title,
      cwd: c.cwd || state.settings.defaultCwd,
      model: c.model || 'default',
      effort: c.effort || 'default',
      permissionMode: c.permissionMode || 'acceptEdits',
      skills: c.skills || [],
      agent: c.agent || null,
      worktree: !!c.worktree,
      openPr: !!c.openPr,
      priority: c.priority || 0,
      acceptanceCriteria: c.acceptanceCriteria || '',
      issueNumber: Number.isInteger(c.issueNumber) ? c.issueNumber : null,
      status: 'backlog',
      createdAt: new Date().toISOString(),
      createdBy: 'import',
      retries: 0,
      sessionId: null, error: null, resultText: null, stats: null,
    };
    state.tasks.unshift(task);
    created.push(task);
    broadcast({ type: 'task', task });
  }
  if (created.length) save();
  return created;
}

function importMarkdown(text) {
  return createCards(parseMarkdown(text));
}

// --- data/inbox watcher ---------------------------------------------------
// Drop a .md file in data/inbox/ → cards appear, file moves to inbox/imported.
let onImported = () => {};
const pending = new Map(); // filename -> debounce timer

function processFile(name) {
  const file = path.join(INBOX, name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // moved/deleted before we got to it
  }
  const created = importMarkdown(text);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.renameSync(file, path.join(IMPORTED, `${stamp}-${name}`));
  } catch {}
  console.log(`inbox: imported ${created.length} card(s) from ${name}`);
  if (created.length) onImported(created, `inbox file ${name}`);
}

function watchInbox(callback) {
  onImported = callback || onImported;
  // Anything already sitting in the inbox (dropped while the server was down)
  for (const f of fs.readdirSync(INBOX)) {
    if (f.endsWith('.md')) processFile(f);
  }
  fs.watch(INBOX, (event, name) => {
    if (!name || !name.endsWith('.md')) return;
    // fs.watch fires in bursts while the file is being written — debounce.
    clearTimeout(pending.get(name));
    pending.set(name, setTimeout(() => {
      pending.delete(name);
      processFile(name);
    }, 500));
  });
}

// --- AI drafting: natural language → an import document -------------------
// Runs a one-shot `claude -p` on the subscription (no tools, no session) that
// writes a card doc in the import format; the UI puts it in the textarea for
// review before importing.
const { execFile } = require('child_process');

const FORMAT_SPEC = `---
cwd: /path/to/repo        (frontmatter = file-wide defaults, all optional)
model: sonnet             (fable|opus|sonnet|haiku)
worktree: true
openPr: true
---

## <Card title — imperative, specific>
model: opus               (per-card overrides: model, effort low|medium|high|xhigh|max,
priority: 2                priority 0-3, worktree, openPr, permissions, skills, cwd)
<The prompt: instructions for the executing agent.>

### Acceptance
- <verifiable criteria>`;

// Shared one-shot CLI exec for drafting; keeps the session so drafts can be
// refined with follow-up messages. Resolves { markdown, sessionId }.
function execDraft(args, cwd, timeoutMs) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    execFile('claude', args, { env, cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'draft failed').slice(0, 300)));
      try {
        const out = JSON.parse(stdout);
        let md = out.result || '';
        // strip a wrapping code fence if the model added one anyway
        md = md.replace(/^\s*```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/m, '$1').trim();
        if (!md) return reject(new Error('empty draft'));
        resolve({ markdown: md, sessionId: out.session_id || null });
      } catch (e) {
        reject(new Error(`unparsable draft output: ${e.message}`));
      }
    });
  });
}

function draft(request, ctx = {}) {
  const explore = !!(ctx.explore && ctx.repoPath);
  const prompt = [
    'You draft import documents for Kungfu Kanban — a kanban board where every card is a prompt executed by a fresh coding agent.',
    'Convert the user request below into 1-10 focused cards using EXACTLY this markdown format:',
    '',
    FORMAT_SPEC,
    '',
    'Rules:',
    '- Prompts must be fully self-contained: the executing agent sees NOTHING except the prompt — include repo paths, file names, constraints.',
    '- Every card gets an "### Acceptance" section with verifiable criteria.',
    '- Route frugally: haiku/low for docs and trivial chores, sonnet/medium for routine coding, opus + high only for genuinely hard work.',
    '- When the work targets one of the available repos, set cwd (and worktree: true + openPr: true for coding tasks that should end in a PR).',
    explore
      ? `\nYou are inside the target repo at ${ctx.repoPath}. Before writing the cards, explore it with your Read/Glob/Grep tools — ground every card in REAL files, paths, and the actual architecture. Do not guess paths.`
      : '',
    '',
    `Available repos:\n${(ctx.repos || []).map((r) => `- ${r.name}: ${r.path}`).join('\n') || '(none)'}`,
    `Default cwd: ${ctx.defaultCwd || '(none)'}`,
    '',
    `User request: ${request}`,
    '',
    'Return ONLY the markdown document — no code fences, no commentary before or after.',
  ].filter((l) => l !== '' || true).join('\n');

  const model = require('./models').effective('sonnet');
  const args = ['-p', prompt, '--output-format', 'json', '--model', model];
  args.push('--tools', explore ? 'Read,Glob,Grep' : '');
  return execDraft(args, explore ? ctx.repoPath : undefined, explore ? 420_000 : 180_000);
}

// Refine an existing draft by resuming its session.
function refine(sessionId, message) {
  const args = [
    '-r', sessionId,
    '-p', `${message}\n\nReturn ONLY the complete revised markdown document — no code fences, no commentary.`,
    '--output-format', 'json',
    '--tools', '',
  ];
  return execDraft(args, undefined, 180_000);
}

module.exports = { parseMarkdown, importMarkdown, watchInbox, setBroadcaster, draft, refine, INBOX };
