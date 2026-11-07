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
description: Create and run task cards on the user's Kungfu Kanban board (the personal AI-agent kanban). Trigger when the user says "kungfu todo", "kungfu cards", "add this to my kanban/board/dojo", "queue this for my agents", or asks to turn a plan/feature list/bug list into kanban cards. Converts the work into markdown, drops it in the board's inbox, and owns the batch from import through review to merge.
---

# Kungfu todo — send work to the kanban board

Kungfu Kanban lives at \`${BOARD}\` and watches \`data/inbox/\` — any \`.md\`
file dropped there is auto-imported into Backlog cards and archived. The board
UI is at http://localhost:${PORT} (token-gated when \`data/auth-token\` exists).

**You are the lead.** The board has its own LLM manager (the Sensei), and it is
off by default: it does not triage your cards, review them or merge anything.
That is your job. You draft the cards, launch them, watch them, review the PRs
and merge what is safe to merge. See [Running the batch](#running-the-batch).

## What to do

1. Draft the cards from the user's request (plan, feature list, bugs, chores).
2. Write ONE markdown file to \`${inbox}/<topic>-<yyyymmdd-hhmm>.md\`
   in the format below.
3. Verify the import: within ~2s the file disappears (archived to
   \`inbox/imported/\`). Optionally confirm via the API:
   \`curl -s -H "Authorization: Bearer $(cat ${tokenFile})" http://localhost:${PORT}/api/tasks\`
   If the file is still there after a few seconds, the server is down — tell the
   user (cards import when it next starts). If it's been renamed to
   \`<name>.rejected.md\` instead, the file produced zero cards (no \`##\`
   headings and no \`- [ ]\` checklist items) — fix the format and re-drop it.
4. Tell the user how many cards were created, then run the batch and own it —
   see [Running the batch](#running-the-batch). Nothing else is going to launch
   these cards or look at what comes back.

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
queue: true                   # auto-launch every card on import (alias: autoqueue) —
                              # chained cards just park in Queued behind their deps
---

## <Card title — imperative, specific>
model: opus          # per-card overrides, all optional:
effort: high         # model fable|opus|sonnet|haiku · effort low|medium|high|xhigh|max
priority: 2          # 0-3 · worktree/openPr true|false · permissions acceptEdits|
                     #   bypassPermissions|plan|... (omitted → the board's default)
issue: 42            # links a GitHub issue; the PR will say "Fixes #42"
after: <exact title of an earlier card in this file>   # dependency; repeat for several
publishes: <contract-name> <path-in-repo>   # worktree cards: the file the card writes; the board
                                            # publishes it as a versioned contract when the card
                                            # finishes. Repeat for several. Relative path, no ".."
uses: <contract-name>[@<version>]   # wait until that contract exists (any version, or exactly
                                    # @N). Repeat for several
<Prompt: the instructions the executing agent will receive.>

### Acceptance
- <verifiable criteria you review the finished card against>
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
- **\`uses:\` is weaker than \`after:\`.** \`after:\` means "the code merged";
  \`uses: <contract-name>\` only means "the contract exists". Card B with
  \`uses: api\` starts as soon as card A (\`publishes: api docs/api.md\`)
  publishes v1, before A's PR merges, so B can build against the published
  file in parallel. Pin \`uses: api@2\` to wait for that exact version. Use
  \`after:\` when B needs A's code on the default branch.
- **Set \`queue: true\` when the file declares \`after:\`/\`uses:\`/\`sequential:\` chains.**
  Without it, imported cards land in Backlog and nothing launches them — a
  human has to notice and mass-queue. \`queue: true\` in the frontmatter starts
  every card on import: cards with met deps launch (or park behind
  \`maxConcurrent\`), chained ones park in Queued and cascade automatically as
  their prerequisites ship. Always set it for multi-card chains.
- Always write acceptance criteria. They are the rubric you review the finished
  card against, so make them checkable by someone who was not in this
  conversation.
- **Route frugally** (runs bill to the user's Claude subscription): haiku/low
  for docs and trivial chores, sonnet/medium for routine coding, opus or fable +
  high-or-above only for genuinely hard work. Nothing routes cards for you with
  the Sensei off, so pick a model and effort per card rather than leaving it to
  the board default.
- Coding tasks against a repo: set \`cwd:\` to the repo root; add
  \`worktree: true\` + \`openPr: true\` when a PR is the right deliverable.
- **Set \`base:\` when the repo has a promotion flow.** If PRs must land on a
  staging/integration branch (branch guards like "source-must-be-staging"
  reject PRs straight into main), put \`base: staging\` in the frontmatter —
  the board opens PRs against it and flags any PR that drifts to the wrong
  base. The board also watches every card PR's CI checks and marks the card
  red until they're 100% green, so don't count a card shipped on open alone.
- One file per request; 3–10 focused cards beat one mega-card.
- **Apply the humanizer skill to anything human-readable you produce** — PR
  titles, PR descriptions, result summaries — so it reads like a person wrote it.

## Running the batch

You own the cards you create: launch, watch, review, merge. This is the default,
not something to wait for permission to start.

1. **Check nothing else spawns or merges.** The Sensei is off by default, so
   this is usually a confirmation, but the PR watcher's two auto-fixers are on
   by default and will spawn their own conflict-fix cards and resume sessions
   for red CI — which is how one run ended up paying twice to fix the same
   conflict:
   \`\`\`
   TOKEN=$(cat ${tokenFile})
   curl -s -H "Authorization: Bearer $TOKEN" http://localhost:${PORT}/api/config
   # check manager.enabled, settings.prWatchAutoFix, settings.prWatchAutoFixCi
   \`\`\`
   Note any that are on, turn them off, and put the recorded values back when
   the run ends:
   \`\`\`
   curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
     -d '{"enabled": false}' http://localhost:${PORT}/api/manager/config
   curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
     -d '{"prWatchAutoFix": false, "prWatchAutoFixCi": false}' http://localhost:${PORT}/api/settings
   \`\`\`
   Read them back with \`GET /api/config\` to confirm. There is no
   \`GET /api/settings\`, and \`data/settings.json\` lags (saves are debounced).
2. **Launch.** \`queue: true\` in the frontmatter starts every card on import,
   which is the usual way. Otherwise \`POST /api/tasks/<id>/run\` per card. Tell
   the user how many went out.
3. **Watch.** \`GET /api/tasks\` gives each card's status and its \`prChecks\`
   (passing / failing / pending / conflicting / wrongBase). Read
   \`GET /api/tasks/<id>/transcript\` when a card looks wrong, and prefer
   \`POST /api/tasks/<id>/followup\` ("merge origin/main, resolve X, push") over
   a re-run: it resumes the same session, so the agent keeps its context and one
   writer owns the branch. A card sitting in Review with no PR attached usually
   just needs \`PATCH /api/tasks/<id>\` with its \`prUrl\` (and
   \`"permissionBlocked": false\`), then \`POST /api/prwatch/sweep\`.
4. **Review every PR for real.** Check out the pushed head
   (\`git fetch origin pull/<n>/head\`) and run the repo's own checks there.
   Green CI and the PR body are not a review — agents have reported "all checks
   pass" on heads where they failed. Read the diff against the card's acceptance
   criteria.
5. **Merging: prose yourself, code only with a go-ahead.**
   - A PR whose diff is **only prose** — markdown, changelog, comments, docs —
     and whose checks are green: merge it yourself with
     \`gh pr merge <n> --merge --delete-branch\`.
   - **Anything touching code, tests, config or dependencies: do not merge.**
     Review it, report your verdict and what you ran, and wait for the user to
     say go. This holds however green it looks and however small the diff.
   - Never merge while \`failing > 0\`, \`pending > 0\`, \`conflicting\` or
     \`wrongBase\` is set.
6. **After each merge**, check the work actually landed
   (\`git merge-base --is-ancestor <tip> origin/main\`) and that the board
   cleaned up — it removes the worktree and the local and remote branch itself
   on merge, so just confirm there was nothing left behind.

What still happens without the Sensei: \`after:\` chains and \`queue: true\`
cascade on their own (that is the runner), and the PR watcher keeps watching CI,
marking cards red until checks are green, releasing gated dependents and
cleaning up on merge.
`;
}

// Every skill the board installs into ~/.claude/skills. kungfu-todo is
// generated (bakes in this install's paths); ponytail and humanizer ship
// verbatim in the repo — ponytail vendored from
// https://github.com/DietrichGebert/ponytail (MIT), humanizer vendored from
// the installed Claude Code skill (MIT) — so cards get the lazy-senior-dev
// discipline and human-sounding writing without a separate plugin install.
const SKILLS = [
  { name: 'kungfu-todo', dest: DEST, content },
  {
    name: 'ponytail',
    dest: path.join(os.homedir(), '.claude', 'skills', 'ponytail', 'SKILL.md'),
    content: () => fs.readFileSync(path.join(BOARD, 'skills', 'ponytail', 'SKILL.md'), 'utf8'),
  },
  {
    name: 'humanizer',
    dest: path.join(os.homedir(), '.claude', 'skills', 'humanizer', 'SKILL.md'),
    content: () => fs.readFileSync(path.join(BOARD, 'skills', 'humanizer', 'SKILL.md'), 'utf8'),
  },
];

function statusOf(s) {
  try {
    const cur = fs.readFileSync(s.dest, 'utf8');
    return { name: s.name, installed: true, current: cur === s.content(), path: s.dest };
  } catch {
    return { name: s.name, installed: false, current: false, path: s.dest };
  }
}

function status() {
  return SKILLS.map(statusOf);
}

function install() {
  for (const s of SKILLS) {
    fs.mkdirSync(path.dirname(s.dest), { recursive: true });
    fs.writeFileSync(s.dest, s.content());
  }
  return status();
}

module.exports = { status, install };
