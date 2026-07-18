// The kungfu-todo skill: teaches every Claude Code session on this machine to
// create board cards ("create a kungfu todo for …"). The board generates it
// with this install's real paths and can check/install it from ⚙ Settings.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BOARD = path.join(__dirname, '..');
const DEST = path.join(os.homedir(), '.claude', 'skills', 'kungfu-todo', 'SKILL.md');
const PORT = process.env.PORT || 4747;

function content() {
  const inbox = path.join(BOARD, 'data', 'inbox');
  const tokenFile = path.join(BOARD, 'data', 'auth-token');
  return `---
name: kungfu-todo
description: Create task cards on the user's Kungfu Kanban board (the personal AI-agent kanban). Trigger when the user says "kungfu todo", "kungfu cards", "add this to my kanban/board/dojo", "queue this for my agents", or asks to turn a plan/feature list/bug list into kanban cards. Converts the work into markdown and drops it in the board's inbox for auto-import and manager triage.
---

# Kungfu todo — send work to the kanban board

Kungfu Kanban lives at \`${BOARD}\` and watches \`data/inbox/\` — any \`.md\`
file dropped there is auto-imported into Backlog cards and archived, and the
board's LLM manager (the Sensei) triages the batch. The board UI is at
http://localhost:${PORT} (token-gated when \`data/auth-token\` exists).

## What to do

1. Draft the cards from the user's request (plan, feature list, bugs, chores).
2. Write ONE markdown file to \`${inbox}/<topic>-<yyyymmdd-hhmm>.md\`
   in the format below.
3. Verify the import: within ~2s the file disappears (archived to
   \`inbox/imported/\`). Optionally confirm via the API:
   \`curl -s -H "Authorization: Bearer $(cat ${tokenFile})" http://localhost:${PORT}/api/tasks\`
   If the file is still there after a few seconds, the server is down — tell the
   user (cards import when it next starts).
4. Tell the user how many cards were created. Do NOT run cards; the user (or
   the Sensei, per its autonomy setting) decides what runs.

## File format

\`\`\`markdown
---
cwd: /path/to/target/repo     # file-wide defaults (all optional)
model: sonnet
worktree: true
openPr: true
base: staging                 # PR base branch — REQUIRED when the repo's PRs must
                              # target a staging/integration branch, not the default
sequential: true              # chain the file: each card waits for the one above
---

## <Card title — imperative, specific>
model: opus          # per-card overrides, all optional:
effort: high         # model fable|opus|sonnet|haiku · effort low|medium|high|xhigh|max
priority: 2          # 0-3 · worktree/openPr true|false · permissions acceptEdits|
                     #   bypassPermissions|plan|... (omitted → the board's default)
issue: 42            # links a GitHub issue; the PR will say "Fixes #42"
after: <exact title of an earlier card in this file>   # dependency; repeat for several
<Prompt: the instructions the executing agent will receive.>

### Acceptance
- <verifiable criteria the manager reviews against>
\`\`\`

A file with no \`##\` headings works too: each \`- [ ] item\` becomes a card.

## Card-writing rules

- **Prompts must be self-contained.** The agent that runs a card starts with
  ZERO conversation context — include file paths, repo names, constraints, and
  any decisions already made in the current session.
- **Declare dependencies — never prose-guard them.** When card B builds on
  card A (needs A's code merged first), give B \`after: <A's exact title>\`
  (repeat the line for several prerequisites), or set \`sequential: true\` in
  the frontmatter to chain the whole file in order. The board holds a dependent
  card in Queued until its prerequisites are Done (approved / PR merged), then
  launches it automatically — so the whole chain can be queued at once. Do NOT
  write prompts like "if X hasn't merged yet, stop and report": that burns a
  full agent run just to discover the block.
- Always write acceptance criteria; the Sensei reviews finished work against them.
- **Route frugally** (runs bill to the user's Claude subscription): haiku/low
  for docs and trivial chores, sonnet/medium for routine coding, opus or fable +
  high-or-above only for genuinely hard work. When unsure, set nothing and let
  the Sensei route it.
- Coding tasks against a repo: set \`cwd:\` to the repo root; add
  \`worktree: true\` + \`openPr: true\` when a PR is the right deliverable.
- **Set \`base:\` when the repo has a promotion flow.** If PRs must land on a
  staging/integration branch (branch guards like "source-must-be-staging"
  reject PRs straight into main), put \`base: staging\` in the frontmatter —
  the board opens PRs against it and flags any PR that drifts to the wrong
  base. The board also watches every card PR's CI checks and marks the card
  red until they're 100% green, so don't count a card shipped on open alone.
- One file per request; 3–10 focused cards beat one mega-card.
`;
}

function status() {
  try {
    const cur = fs.readFileSync(DEST, 'utf8');
    return { installed: true, current: cur === content(), path: DEST };
  } catch {
    return { installed: false, current: false, path: DEST };
  }
}

function install() {
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, content());
  return status();
}

module.exports = { status, install };
