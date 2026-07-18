---
name: kungfu-todo
description: Create task cards on the user's Kungfu Kanban board (the local AI-agent kanban). Trigger when the user says "kungfu todo", "kungfu cards", "add this to my kanban/board/dojo", "queue this for my agents", or asks to turn a plan/feature list/bug list into kanban cards. Converts the work into markdown and drops it in the board's inbox for auto-import and manager triage.
---

# Kungfu todo — send work to the kanban board

> **Install** (one-time): copy this folder to `~/.claude/skills/`, then replace every
> `<board>` in this file with the absolute path to your kungfu-kanban clone:
>
> ```bash
> cp -r skills/kungfu-todo ~/.claude/skills/
> ```

Kungfu Kanban lives at `<board>`. Its server watches `data/inbox/` — any `.md` file
dropped there is auto-imported into Backlog cards and archived, and the board's LLM
manager (the Sensei) triages the batch. The board UI is at http://localhost:4747
(token-gated if `<board>/data/auth-token` exists).

## What to do

1. Draft the cards from the user's request (plan, feature list, bugs, chores).
2. Write ONE markdown file to `<board>/data/inbox/<topic>-<yyyymmdd-hhmm>.md`
   in the format below.
3. Verify the import: within ~2s the file disappears from `inbox/` (archived to
   `inbox/imported/`). Optionally confirm the cards via the API:
   `curl -s -H "Authorization: Bearer $(cat <board>/data/auth-token)" http://localhost:4747/api/tasks`
   (drop the header if no token gate is set up). If the file is still there after a
   few seconds, the server is down — tell the user (cards will import when it next
   starts; if it runs under launchd per the README,
   `launchctl kickstart -k gui/$(id -u)/com.kungfu-kanban` restarts it).
4. Tell the user how many cards were created. Do NOT run cards; the user (or the
   Sensei, per its autonomy) decides what runs.

## File format

```markdown
---
cwd: /path/to/target/repo     # file-wide defaults (all optional)
model: sonnet
worktree: true
openPr: true
---

## <Card title — imperative, specific>
model: opus          # per-card overrides, all optional:
effort: high         # model fable|opus|sonnet|haiku · effort low|medium|high|xhigh|max
priority: 2          # 0-3 · worktree/openPr true|false · permissions acceptEdits|plan|...
<Prompt: the instructions the executing agent will receive.>

### Acceptance
- <verifiable criteria the manager reviews against>
```

A file with no `##` headings works too: each `- [ ] item` becomes a card.

## Card-writing rules

- **Prompts must be self-contained.** The agent that runs a card starts with ZERO
  conversation context — include file paths, repo names, constraints, and any
  decisions already made in the current session.
- Always write acceptance criteria; the Sensei reviews finished work against them.
- **Route frugally** (runs bill to the user's Claude subscription): haiku/low for
  docs and trivial chores, sonnet/medium for routine coding, opus or fable +
  high-or-above only for genuinely hard work. When unsure, set nothing and let
  the Sensei route it.
- Coding tasks against a repo: set `cwd:` to the repo root; add `worktree: true`
  and `openPr: true` when a PR is the right deliverable.
- One file per request; 3–10 focused cards beat one mega-card.
