# Kungfu Kanban 🥋

A personal kanban board where every card is an AI task, executed by the **Claude Code
CLI on your subscription login** — no API keys, no token billing, no cloud. The runner
strips `ANTHROPIC_API_KEY` from the environment before spawning, so it can never
silently fall back to pay-per-token.

> This used to be a two-edition repo with a hosted SaaS variant (Stripe, Clerk, Neon,
> Vercel Sandbox). That edition is deleted — this is a tool for one person.

**How it works:** an Express server (`server.js`) serves the board UI and spawns
`claude -p <prompt> --output-format stream-json` per card. Output streams into the
card's transcript over server-sent events. An LLM "Manager" (also a `claude -p` call)
triages, dispatches, and reviews cards. Everything persists as JSON files in `data/`.

---

## Requirements

| Thing | Why | Check |
|---|---|---|
| **Node 20+** | server runtime (uses global `fetch`) | `node -v` |
| **Claude Code CLI**, logged in on your subscription | runs every card | `claude --version`, then `claude` → `/login` if needed |
| **git** | worktree isolation for repo cards | `git -v` |
| **GitHub CLI (`gh`)**, authed | only for "Open PR when done" | `gh auth status` |
| **macOS** | desktop notifications (`osascript`); the rest works anywhere | — |
| **Tailscale** (optional) | use the board from your phone | `tailscale status` |

## Quick start

```bash
git clone <this repo> && cd kungfu-kanban
npm install
npm start          # → http://localhost:4747
```

That's it for local use. The server binds `127.0.0.1` only by default.

---

## The board

Columns: **Backlog → Queued → Running → Review → Done**

- **＋ New card** (or drag an existing card to **Queued**, or ▶ Run in the card
  drawer) launches it.
- **parallel** (toolbar, 1–8, default 2) caps concurrent sessions so you don't burn
  subscription rate limits; extra launches wait in Queued and start automatically as
  slots free up.
- Click any card for the **drawer**: live transcript, token/turn stats, and a
  `claude -r <session-id>` command to resume that session in your terminal.
- Finished runs land in **Review** (with a vermillion error stripe if they failed).
  **✓ Done** ships them — hanko seal included.
- If the server restarts mid-run, orphaned "running" cards are recovered into Review.
- **⚙ Settings** (toolbar): default working directory, repos directory, ntfy
  topic, macOS notification toggle, and Done-column archiving (see below).
- **☀ / ☾** toggles the day/night dojo. Night is the default.

### Archiving old Done cards

The Done column would otherwise grow forever, so a daily sweep moves cards out
once they've sat in Done longer than `settings.archiveDays` (default 7,
measured from `finishedAt`, falling back to `createdAt`). Archived cards are:

- appended as full JSON to `data/archive.jsonl` (one line per card), and
- removed from `data/tasks.json`, with their `data/transcripts/<id>.jsonl` file deleted.

The sweep runs once at server startup and every 24h after that. Set
**Archive "done" cards after (days)** to `0` in ⚙ Settings to turn it off;
archived history in `data/archive.jsonl` is never deleted automatically.

### Follow-up prompts

Open any card that has run and type in the **follow-up box** under the transcript
("fix the bug where…", "also add…"). The run **resumes the same CLI session**
(`claude -r`), so the agent keeps its full context — and for worktree cards it
re-enters the original worktree, so a follow-up push updates the existing PR.
Follow-ups respect the parallel cap and queue like any run; the follow-up text is
appended to the card's prompt so Sensei reviews and retries see it.

### Subscription limits — automatic cooldown

When a run dies on a usage/rate limit, the board:

- parses the reset time from the CLI's error (falls back to a 1-hour backoff),
- **requeues the card** (it wasn't a real failure) and pauses all auto flow —
  queue pumping, Sensei triggers, PR auto-fix — until the limit resets,
- shows a **⏳ countdown chip** in the header, and pings your phone.

Manual run clicks during cooldown queue instead of burning against the wall.
When the timer expires everything queued launches automatically and you get a
"training resumes" notification.

**Model fallback**: a *model-specific* cap or outage (e.g. an Opus-hours limit
while Sonnet still works, or a 529 overload) doesn't pause anything — the failed
model is blocked temporarily (30 min for caps, 10 for overloads), the card
requeues, and launches step down the ladder **fable → opus → sonnet → haiku**
until the block expires. Cards keep their configured model and climb back up
automatically; a **⬇ chip** in the header shows what's stepped down, and the
transcript notes every substitution. The Sensei's own runs substitute too.

### Card fields

| Field | Maps to | Notes |
|---|---|---|
| Title | — | shown on the card, PR title, notification text |
| Prompt | the `claude -p` prompt | what the agent should do |
| Working directory | process `cwd` | repo dropdown (scans the ⚙ Settings repos directory for git repos) or any path |
| Model | `--model` | default / fable / opus / sonnet / haiku |
| Effort | `--effort` | default / low / medium / high / xhigh / max |
| Permissions | `--permission-mode` | `acceptEdits` (default), `auto`, `plan`, `dontAsk`, `bypassPermissions` — see [Security](#security-notes) |
| Agent | `--agent` | your custom agents from `~/.claude/agents/*.md` |
| Git worktree | `--worktree kanban-<id>` | isolates the run on its own branch |
| Open PR when done | post-run `gh pr create` | requires worktree; see below |
| Priority | sort order (0–3) | 2+ shows the vermillion square |
| Acceptance criteria | manager review rubric | the Sensei approves/rejects against this |
| Repeat | schedule (interval or daily) | `6h` every 6 hours, `14:30` daily — see [Scheduled cards](#scheduled-cards) |
| Skills | injected into the prompt | pick from installed skills, or **✦ auto-select** to let the agent choose |

### Skills & agents discovery

Auto-discovered at load, no config:

- Personal skills: `~/.claude/skills/*/SKILL.md`
- Plugin skills: every enabled plugin in `~/.claude/plugins/installed_plugins.json`
  (their `skills/` and `workflow-skills/` dirs), namespaced `plugin:skill`
- Agents: `~/.claude/agents/*.md`

### Scheduled cards

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

---

## Importing cards from Markdown

Turn a plan into a backlog in one paste. Two entry points:

- **⇪ Import** (toolbar): paste markdown or pick a file — works from your phone.
- **Watch folder**: drop `.md` files into `data/inbox/` — cards appear
  automatically and the file is archived to `data/inbox/imported/`. Files already
  in the inbox when the server starts are imported too.

Two formats, auto-detected:

**Sections** — every `## Heading` becomes a card. The heading is the title,
leading `key: value` lines set fields, an `### Acceptance` subsection becomes the
acceptance criteria, everything else is the prompt. Optional frontmatter sets
file-wide defaults:

```markdown
---
cwd: /Users/you/project
model: sonnet
worktree: true
openPr: true
---

## Fix the flaky login test
model: opus
priority: 2
The test in auth.spec.ts fails intermittently because…

### Acceptance
- passes 10x in a row

## Update the README badges
```

Recognized keys (case/space-insensitive): `cwd` (`dir`/`repo`), `model`, `effort`,
`permissions`, `priority` (0–3), `worktree`, `openPr` (`pr`), `agent`,
`skills` (comma-separated), `acceptance`. Unknown or invalid values are ignored;
a card with no body uses its title as the prompt.

**Checklist** — a file with no `##` headings: every unchecked `- [ ] item`
becomes a card (checked items are skipped).

**From Claude Code**: a personal skill at `~/.claude/skills/kungfu-todo/SKILL.md`
teaches every Claude Code session (any project) to do this on request — say
"create a kungfu todo for …" and it drafts the cards, drops the file in the
inbox, and confirms the import. The skill encodes the format, frugal
model-routing, and the self-contained-prompt rule (card agents start with zero
conversation context).

Imported cards land in **Backlog** tagged `import`, and the Sensei gets one
triage ping per batch (if the new-card trigger is on) — so you can paste a plan,
and routing/prioritization happens for you.

## Repo cards → real PRs

Give a card a working directory that's a git repo with an `origin` remote, check
**Git worktree** + **Open PR when done**, and run it. After the agent succeeds:

1. The worktree is located by asking git (`git worktree list`) for the branch
   named `kanban-<card-id>` — wherever the CLI put it.
2. Anything the agent left uncommitted is committed (`<card title>` / "via Kungfu
   Kanban").
3. If the branch has no commits beyond the base (the branch your main checkout is
   on), the flow stops — no empty PRs.
4. The branch is pushed to `origin` and `gh pr create` opens a PR: title = card
   title, body = prompt + acceptance criteria.
5. The **PR link** lands on the card, in the drawer, and in your phone notification.

Every step logs to the card transcript (`⇡` lines). Failures (no remote, `gh` not
authed, push rejected…) log an `✕` line and leave the card in Review — the work is
still in the worktree, nothing is lost.

**One-time setup:** `gh auth login` (with push scope to the repos you'll use).

### PR watch — merged PRs ship, conflicted PRs self-heal

Every N minutes (⚙ Settings, default 10, 0 = off) the board checks each Review
card's PR via `gh`:

- **Merged** → the card moves to Done ("PR merged") and you get a notification.
- **Closed without merge** → noted once on the card transcript.
- **Conflicting** (main moved under the branch) → with auto-fix on (default), the
  board spawns a **fix card**: a fresh agent run *inside the original worktree*
  that merges the base branch, resolves the conflicts preserving both sides, and
  pushes — updating the PR in place. Max 2 attempts per PR, one active fixer at a
  time; after that you get a "needs you" notification and it stops. Fix cards
  wear an `auto-fix` badge and flow through the normal columns, so the Sensei
  reviews the resolution like any other run.

Keep local `main` pushed: agent worktrees branch from the default branch, so an
unpushed main is how you get avoidable conflicts in the first place.

---

## Notifications

When a card lands in **Review** (or fails), you get notified. User-stopped runs
don't notify.

### macOS (on by default)

Fires via `osascript`. Toggle in ⚙ Settings. If nothing appears, check System
Settings → Notifications → allow notifications for "Script Editor" / your terminal.

### Phone (ntfy)

1. Install the **ntfy** app ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
   [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)) — no
   account needed.
2. Pick a long, unguessable topic name (ntfy topics are a public namespace — anyone
   who knows the name can read it): e.g. `kk-$(openssl rand -hex 8)`.
3. Put it in **⚙ Settings → ntfy topic** on the board.
4. In the ntfy app: **+ → Subscribe to topic** → same name.

Pushes include the card title, and tapping one opens the PR when there is one.
Because the topic is public-by-obscurity, keep card titles free of secrets.

**🔔 Test notification** (in ⚙ Settings) fires both channels on demand — use it to
verify the phone hookup. You can also watch the topic live at
`https://ntfy.sh/<your-topic>` in any browser.

---

## Use it from your phone (Tailscale)

The server **refuses** to bind beyond loopback without an access token, because the
runner executes code. The safe path is a token + Tailscale (the port stays on
loopback; Tailscale proxies it inside your tailnet only):

```bash
# 1. one-time: create the token (this enables the login gate)
openssl rand -hex 16 > data/auth-token

# 2. run the board
npm start                          # logs: "token gate: ON"

# 3. one-time: serve it over your tailnet with HTTPS
tailscale serve --bg 4747
tailscale serve status             # shows your https://<machine>.<tailnet>.ts.net URL
```

On your phone: install Tailscale, sign in to the same tailnet, open the URL, enter
the token once — it's stored as a cookie for a year. Scripts/API calls can send
`Authorization: Bearer <token>` instead.

**Install it as an app**: the board is a PWA. On iPhone, open the tailnet URL in
Safari → Share → **Add to Home Screen** — you get a standalone full-screen app
with the robot icon and night-dojo status bar.

- Token can also come from the `KFK_TOKEN` env var (overrides the file).
- Rotate it by regenerating `data/auth-token` (old cookies stop working).
- `tailscale serve` is tailnet-only. **Never** use `tailscale funnel` or a public
  port-forward for this app.
- To stop sharing: `tailscale serve --https=443 off` (or `tailscale serve reset`).

---

## The Manager (the Sensei)

An LLM manager — itself a `claude -p` structured-output call on your subscription —
that triages new cards (model/effort/skills/priority routing), dispatches queued
work, reviews finished cards against their acceptance criteria, and answers you in
chat ("plan the auth refactor into cards", "what's blocking?").

**Autonomy ladder** (Manager tab):

| Level | Can do without you |
|---|---|
| `suggest` *(default)* | nothing — every action waits for your ✓ |
| `semi` | create / route / run cards; approve-reject verdicts still wait |
| `auto` | everything, within guardrails |

Deleting cards is never available to the manager, at any level.

**Triggers:** on task finish (review it), on new card (triage it), every N minutes
(0 = off), and chat. Each trigger is one manager invocation — mind your rate limits
before enabling the interval.

**Guardrails:** max launches/hour (default 10), max retries/task (default 2 —
rejected cards re-run with the manager's feedback appended to the prompt), and a
**permission ceiling** (default `acceptEdits`) the manager can't assign beyond.
Guardrail-blocked actions become suggestions instead of executing.

**Management style:** freeform standing instructions ("prefer haiku for docs tasks",
"never auto-approve migrations") — no code changes needed.

The manager's own model/effort (default opus/medium) are configurable; it can also
be disabled entirely with the checkbox.

---

## Run at login (optional)

`~/Library/LaunchAgents/com.kungfu-kanban.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kungfu-kanban</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>  <!-- `which node` -->
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/path/to/kungfu-kanban</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd's PATH is minimal; claude + gh + git must be findable -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/kungfu-kanban.log</string>
  <key>StandardErrorPath</key><string>/tmp/kungfu-kanban.log</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.kungfu-kanban.plist   # start now + at login
launchctl unload ~/Library/LaunchAgents/com.kungfu-kanban.plist # stop
```

---

## Configuration reference

**Environment variables**

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `4747` | listen port |
| `HOST` | `127.0.0.1` | bind address; anything non-loopback requires a token |
| `KFK_TOKEN` | — | access token (overrides `data/auth-token`) |

**Files (`data/`, gitignored — this is all app state)**

| File | Contents |
|---|---|
| `tasks.json` | all cards |
| `settings.json` | parallel cap, default cwd, ntfy topic, notification toggle, archive-after-days, manager config |
| `manager.json` | pending suggestions, chat history, launch timestamps |
| `manager-log.jsonl` | manager activity log |
| `transcripts/<task-id>.jsonl` | per-card transcript |
| `archive.jsonl` | Done cards swept out after `archiveDays` (append-only) |
| `auth-token` | access token (create to enable the gate) |

Back up `data/` to keep your board; delete it to factory-reset. Individual sessions
can always be reopened in the terminal with `claude -r <session-id>` (shown in each
card's drawer).

---

## Troubleshooting

- **Card fails instantly with "Failed to launch claude CLI"** — `claude` isn't on
  the server's PATH (common under launchd; fix the plist PATH above) or isn't
  installed.
- **Run errors mentioning auth/login** — the CLI isn't logged in: run `claude` in a
  terminal, `/login`, pick your subscription account. API-key auth can't be used —
  the runner deletes `ANTHROPIC_API_KEY` on purpose.
- **PR flow: "no worktree matching …"** — the card ran without the worktree box, or
  the cwd isn't a git repo. **"gh pr create failed"** — check `gh auth status` and
  that `origin` points at GitHub.
- **Port already in use** — `lsof -nP -iTCP:4747 -sTCP:LISTEN`, kill the old server.
- **No macOS notifications** — System Settings → Notifications: allow "Script
  Editor"/terminal; check the ⚙ Settings toggle.
- **Hitting subscription rate limits** — lower **parallel**, prefer haiku/sonnet +
  low effort for routine cards, disable the manager interval trigger, or use the
  Sensei's frugality bias (it's prompted to route cheap by default).
- **Server won't start: "Refusing to bind …"** — you set `HOST` without a token.
  Create `data/auth-token` (or unset `HOST` and use Tailscale serve, which works
  with loopback).

## Security notes

This board **executes code on your machine** with whatever permission mode a card
carries — `bypassPermissions` means exactly that. Accordingly:

- The server never binds beyond loopback without a token, and you shouldn't either.
  Tailscale serve (tailnet-only) + token is the supported remote path. No public
  exposure, ever.
- The manager's permission ceiling stops it from escalating cards beyond what you
  allow; deleting cards is hard-blocked regardless of autonomy.
- ntfy topics are public-by-obscurity: unguessable names only, no secrets in card
  titles.
- The token cookie is `HttpOnly`/`SameSite=Lax`, compared timing-safe, and lives a
  year; rotate `data/auth-token` to invalidate.
