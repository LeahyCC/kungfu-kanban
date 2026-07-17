# Kungfu Kanban 🥋

A personal kanban board where every card is an AI task, run through the **Claude Code
CLI on your subscription login** — no API keys, no token billing, no cloud. The runner
even strips `ANTHROPIC_API_KEY` from the environment before spawning, so it can't
silently fall back to pay-per-token.

> This used to be a two-edition repo with a hosted SaaS variant (Stripe, Clerk, Neon,
> Vercel Sandbox). That edition is deleted — this is a tool for one person: me.

## Run

```bash
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
and enabled plugins.

## Board flow

Backlog → Queued → Running → Review → Done

- Drag a card to **Queued** (or hit ▶ Run) to launch it.
- **parallel** (toolbar) caps concurrent sessions so parallel tasks don't burn
  through your subscription rate limits; extras wait in Queued.
- Click a card for the live transcript, stats, and a `claude -r <session-id>`
  command to resume the session in your terminal.
- Finished tasks land in **Review**; shipping earns the vermillion seal.

Task data lives in `data/` (JSON + per-task transcripts). Delete it to reset.

## Repo cards → real PRs

Check **Git worktree** + **Open PR when done** on a card whose working directory is a
git repo. After the agent finishes, the board commits anything left uncommitted in the
worktree, pushes the branch, and opens a PR with your existing **`gh` auth** — no PAT,
no sandbox. The PR link lands on the card in Review.

## Notifications

- **macOS**: a notification fires when a card lands in Review or a run fails
  (toggle in ⚙ Settings).
- **Phone**: set an ntfy topic in ⚙ Settings and subscribe to it in the
  [ntfy app](https://ntfy.sh) — pushes include a tap-through link to the PR when
  there is one. Pick an unguessable topic name; ntfy topics are public namespaces.

## Access from anywhere (Tailscale)

The server binds `127.0.0.1` only, and refuses to bind wider without a token. To use
the board from your phone:

```bash
openssl rand -hex 16 > data/auth-token   # enables the token gate (or export KFK_TOKEN)
npm start
tailscale serve --bg 4747                # HTTPS on your tailnet, proxied to localhost
```

Open the tailnet URL, enter the token once — it's a cookie for a year. API calls can
send `Authorization: Bearer <token>` instead. The gate exists because the runner
executes code: **never** expose the port without it.

## Manager tab — the Sensei

An LLM manager (also a `claude -p` session on your subscription) that triages,
routes, dispatches, and reviews cards against their acceptance criteria.

- **Autonomy ladder**: `suggest` (everything needs your ✓) → `semi` (can
  create/route/run; verdicts need your ✓) → `auto` (full autopilot within
  guardrails). Deleting cards is never available to the manager.
- **Triggers**: on task finish, on new card, on an interval, or via chat.
- **Guardrails**: max launches/hour, max retries/task (rejected tasks re-run with
  the manager's feedback appended), and a permission ceiling it can't assign beyond.
- **Management style**: a freeform prompt to tune behavior ("prefer haiku for docs
  tasks", "never auto-approve migrations") without code.
