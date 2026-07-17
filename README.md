# Claude Kanban

A local kanban board that runs tasks through the **Claude Code CLI** — so everything
runs on your Anthropic subscription (OAuth login), never API-key token billing.
The runner even strips `ANTHROPIC_API_KEY` from the environment before spawning,
so it can't silently fall back to pay-per-token.

## Run

```bash
cd claude-kanban
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
