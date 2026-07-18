# Changelog

All notable changes to Kungfu Kanban. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver-ish —
minor bumps for features, patch bumps for fixes. The board's status line
compares your clone against `origin/main` and offers a one-click update.

## [Unreleased]

### Fixed
- Cards no longer sit in a silent, subscription-burning approval loop. When a
  headless run ends blocked on a tool permission — a Bash command that must
  leave the sandbox, a deny rule, or a mode that won't auto-approve Bash — the
  CLI reports it as `permission_denials` while still exiting "success". The
  board now reads that field, marks the card failed-in-review with the real
  remedy, and no longer lets the agent's "please approve" message masquerade as
  a finished result. A natural-language "yes" can't grant a headless permission,
  so the note points at the actual levers: raise the card's mode or add an
  allow-rule.
- Landing page UX pass: anchor links no longer scroll chapters under the sticky
  masthead; long inline commands wrap on phones instead of pushing the page
  sideways; the TOC scrolls on short viewports; the theme toggle announces its
  state (`aria-pressed`) and updates the browser theme-color; added a skip link.

### Added
- Permissions is a live select in the card drawer now (alongside model and
  effort), so a blocked card can be raised and re-run without opening the editor.
- Landing page: scroll tracking for the manual — the TOC highlights the chapter
  you're reading, and a vermillion progress stroke under the masthead shows how
  far down the page you are.

### Changed
- README: launchd section uses modern bootstrap/bootout/kickstart commands and
  documents the "Load failed: 5" already-loaded gotcha
- README troubleshooting covers a card stuck asking for approval

## [0.2.8] — 2026-07-17

### Fixed
- PR base selection asks the actual remote (`ls-remote`) instead of trusting
  local remote-tracking refs, which go stale when a pushed branch is later
  deleted on GitHub; falls back to gh's authoritative default branch, with a
  final retry against it if GitHub still rejects the base

## [0.2.7] — 2026-07-17

### Fixed
- Import-modal housekeeping: one operation at a time (draft/refine/issues
  disable each other), the active button becomes ✕ cancel, cancelling kills
  the server-side claude process (no wasted usage), closing the modal aborts
  in-flight work, and 🔍 explore refuses to start without a repo selected

## [0.2.6] — 2026-07-17

### Changed
- Settings shows the board version in its title, and the usage panel moved to
  the top of the modal with the budget field beside it
- With a budget set, a colored "left (5h)" stat leads the panel and the
  ⛽ header chip shows remaining tokens ("5h 1.2M left") instead of a bare %

## [0.2.5] — 2026-07-17

### Fixed
- PR base selection: if the main checkout sits on a local-only branch, the PR
  bases on origin's default branch instead (GitHub rejects unpushed bases);
  the ahead-check now compares against origin too
- `gh pr create` retries once after a beat when GitHub hasn't indexed the
  just-pushed branch yet
- `prUrl` is PATCHable as a repair hatch for manually-opened PRs

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
