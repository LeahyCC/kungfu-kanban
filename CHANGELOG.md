# Changelog

All notable changes to Kungfu Kanban. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver-ish —
minor bumps for features, patch bumps for fixes. The board's status line
compares your clone against `origin/main` and offers a one-click update.

## [Unreleased]

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
