# Kungfu Kanban

A local kanban board that runs tasks through the **Claude Code CLI** — so everything
runs on your Anthropic subscription (OAuth login), never API-key token billing.
The runner even strips `ANTHROPIC_API_KEY` from the environment before spawning,
so it can't silently fall back to pay-per-token.

## Run

```bash
cd kungfu-kanban
npm install
npm start          # http://localhost:4747
```

## What each card controls

| Field | CLI flag |
|---|---|
| Model (fable / opus / sonnet / haiku) | `--model` |
| Effort (low → max) | `--effort` |
| Permissions (acceptEdits, plan, bypassPermissions, …) | `--permission-mode` |
| Agent | `--agent` |
| Git worktree isolation | `--worktree` |
| Skills | injected into the prompt (picked from your installed skills) |
| Working directory | process `cwd` |

Skills and agents are auto-discovered from `~/.claude/skills`, `~/.claude/agents`,
and enabled plugins in `~/.claude/plugins/installed_plugins.json`.

## Board flow

Backlog → Queued → Running → Review → Done

- Drag a card to **Queued** (or hit ▶ Run) to launch it.
- **parallel** (header) caps concurrent sessions so parallel tasks don't burn
  through your subscription rate limits; extras wait in Queued.
- Click a card for the live transcript, stats, and a `claude -r <session-id>`
  command to resume the session in your terminal.
- Finished tasks land in **Review** so you can inspect the result/diff before
  marking them Done.

Task data lives in `data/` (JSON + per-task transcripts). Delete it to reset.

## Scheduled cards

Give a card a **Repeat** value in the editor to run it on a schedule:

- `6h` (or `6`) — every 6 hours (fractional hours like `0.5h` are allowed)
- `14:30` — daily at 14:30 (24-hour local time)

The server checks once a minute. When a card is due, it's **cloned into a fresh
one-shot card** (with no schedule of its own) that's launched via the normal
runner — so clones respect the **parallel** (maxConcurrent) queue and flow
Backlog → Running → Review → Done like any other card. The scheduled card itself
stays in **Backlog** carrying a `⏱` badge and never moves columns on its own;
drag it elsewhere and it stops firing until it's back in Backlog. Clear the
Repeat field to turn scheduling off.

## Manager tab

An LLM manager (also a `claude -p` session on your subscription) that triages,
routes, dispatches, and reviews cards. It receives a board snapshot and returns
structured actions (create/update/run/approve/reject) that are executed or held
for your approval.

- **Autonomy**: `suggest` (everything needs your ✓), `semi` (can create/route/run;
  review verdicts need your ✓), `auto` (full autopilot within guardrails).
  Deleting cards is never available to the manager.
- **Triggers**: on task finish (reviews the result against the card's acceptance
  criteria), on new card (triage/routing), on an interval, or via the chat box.
- **Guardrails**: max launches per hour, max retries per task (rejected tasks are
  re-run with the manager's feedback appended to the prompt), and a permission
  ceiling the manager can't assign beyond. Guardrail-blocked actions become
  suggestions instead of executing.
- **Management style**: a freeform prompt in settings to tune its behavior
  ("prefer haiku for docs tasks", "never auto-approve migrations") without code.

Cards now also carry a **priority** (0–3, sorts columns) and **acceptance
criteria** (what the manager reviews against).
