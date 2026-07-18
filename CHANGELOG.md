# Changelog

All notable changes to Kungfu Kanban. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver-ish —
minor bumps for features, patch bumps for fixes. The board's status line
compares your clone against `origin/main` and offers a one-click update.

## [Unreleased]

## [0.2.4] — 2026-07-17

### Fixed
- Hook detection also catches "command not found" failures (e.g. a pre-push
  tsc/typecheck in a bare worktree), so the --no-verify fallback fires there too

## [0.2.3] — 2026-07-17

### Fixed
- PR flow survives repos with husky/lint-staged hooks: hooks can't run in a
  bare worktree (no node_modules), so hook-machinery failures retry the
  commit/push with --no-verify and note it in the transcript — real git
  errors still fail loudly
- The resume command now copies `cd "<run dir>" && claude -r <id>` — sessions
  are per-directory, so the bare command failed from anywhere else (worktree
  runs record their actual run directory)

## [0.2.2] — 2026-07-17

### Fixed
- SHIPPED seals no longer flicker: the stamp animation plays once per card
  instead of replaying on every board rebuild, and running-card telemetry
  broadcasts are throttled to one per 2s per task

## [0.2.1] — 2026-07-17

### Fixed
- The usage breakdown in ⚙ Settings is a proper stat panel (big numbers,
  labels, model badges, budget bar) instead of a run-on sentence

## [0.2.0] — 2026-07-17

The public launch. Everything after the SaaS-edition delete, in one line each:

### Added
- Repo cards → real PRs via local worktrees + `gh` (no PAT, no sandbox)
- PR watch: merged PRs stamp their card Done; conflicted PRs spawn auto-fix
  cards that merge main in the original worktree and push (max 2 tries)
- ⇉ Merge PR / Close PR from the card drawer
- The Sensei: LLM manager with autonomy ladder, triggers, guardrails
- Markdown import: `##` sections or checklists → cards; `data/inbox/` watch
  folder; ✨ AI drafting with 🔍 repo exploration and ↻ refinement; live parse
  preview with duplicate guard; ⇣ GitHub-issues import with `Fixes #N` PRs
- `kungfu-todo` Claude Code skill, generated + installable from ⚙ Settings
- Follow-up prompts: resume a card's session with new instructions in place
- Scheduled cards (`6h` intervals / daily `14:30`, sleep-safe catch-up)
- Auto-archive of old Done cards to `data/archive.jsonl`
- Subscription cooldown (requeue + pause + countdown chip) and model fallback
  ladder (fable → opus → sonnet → haiku) with ⬇ chip
- ⛽ rolling 5-hour usage meter from local session logs, optional budget %
- Live per-card telemetry: output tokens + session context (ctx %)
- Per-column quick actions (▶ run · ⏸ unqueue · ✓ approve · ✕ delete)
- Editable prompt ("The work") and model/effort selects in the drawer;
  click-to-copy resume command
- Notifications: macOS + ntfy push with PR tap-through; 🔔 test button
- Token gate + Tailscale remote access; PWA install on phones
- System status line (CLI/gh health), one-click `claude update`, and
  board self-update against origin
- INK & TAPE design system: night/day dojo, belts, seals, antenna

### Changed
- Single edition: the web/SaaS variant is gone; local-first, subscription-only

## [0.1.0] — 2026-07-16

Original two-edition repo: hosted SaaS prototype (Next.js/Stripe/Clerk/Neon)
plus the local Claude-Code-CLI edition that became the whole product.
