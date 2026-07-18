# Changelog

All notable changes to Kungfu Kanban. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver-ish —
minor bumps for features, patch bumps for fixes. The board's status line
compares your clone against `origin/main` and offers a one-click update.

## [Unreleased]

## [0.6.0] — 2026-07-18

### Added — first-class card dependencies (chains run in order, unattended)
- Cards can declare prerequisites (`deps`, an array of card ids). A queued card
  waits until every dep is **Done** (approved, PR merged, or dragged there),
  then launches automatically — queue a whole chain at once and it executes in
  order. Deleted/archived deps count as met so cleanups can't wedge the queue.
- Import format: `after: <card title>` per card (repeat the line for several;
  ordinals like `#2`, ids, and `previous` work too) and `sequential: true` in
  the frontmatter to chain the whole file. Unresolvable `after:` names land on
  the card as `depsUnresolved` for the Sensei to fix instead of vanishing.
  The kungfu-todo skill and ✨ Draft prompt now teach: **declare dependencies,
  never prose-guard them** — "stop if X hasn't merged" burns a run discovering
  the block; `after:` prevents the run entirely.
- Sensei: the snapshot shows each card's deps (with live statuses), and a new
  `requeue_task` action returns a stalled review card to Queued **without
  burning a retry** — the fix for dependency self-stops, paired with
  `update_task deps:[…]` so the card relaunches only when its prerequisite
  ships. Guidance in the manager prompt covers the whole pattern.
- UI: amber `⛓ after: …` badge while prerequisites are unmet (green `⛓ deps
  met` once satisfied, red for unresolved names), a "waits for" line in the
  drawer, and a "Runs after" chip picker in the card editor. Dependency cycles
  are rejected at the API (`400 dependency cycle`).

### Changed — queue discipline
- The queue now launches the highest-priority, oldest, dependency-ready card
  first (it used to be newest-first, ignoring priority), and a finished/shipped/
  deleted card immediately pumps the queue so freed dependents start without
  waiting for the next event. A minute-interval safety pump catches stragglers.

## [0.5.3] — 2026-07-18

### Fixed — mobile board layout + session-limit error spam
- **Stacked columns collapsed on phones.** At ≤700px the board switches from a
  five-column grid to a vertical `flex` stack, but the grid's `align-items:
  start` was never overridden — in column-flex that stops the columns from
  stretching, so empty columns (Backlog/Queued/Done) shrank to their header
  width and populated ones sized to their widest card. Added `align-items:
  stretch` to the mobile `.board` rule so every stacked column fills the width.
- **"Manager output unparsable" logged on every trigger.** When the Sensei's own
  `claude -p` run hit a subscription/session limit, the CLI returned
  `{is_error:true, api_error_status:429, result:"You've hit your session
  limit…"}` — and `manager.js` blindly `JSON.parse`d that human string as a
  decision, logging an error on every triggered invocation. It now inspects the
  wrapper: a limit error trips the board-wide cooldown (pausing auto-flow until
  reset, the same response the runner gives a limit-failed card) and logs a
  single clean "Paused —" note; other run errors log once; only genuinely
  malformed output is reported as unparsable.
- **Newer limit phrasing went undetected.** `cooldown.detect` didn't match the
  CLI's "You've hit your session limit · resets 11:30pm" wording (it keyed off
  "usage limit"/"limit reached"), so a card failing on that message would land
  in Review instead of requeueing behind the cooldown. The pattern now also
  matches "session limit" and "hit your … limit".

## [0.5.2] — 2026-07-17

### Changed — Settings moved into the header
- The ⚙ Settings button moved from the board toolbar up into the header status
  row, right beside the ◐ day/night toggle, and is now icon-only (the word
  "Settings" is dropped; the label lives in its `title`/`aria-label`). The two
  share one square icon-button style (`.icon-btn`) and no longer shrink when the
  header status row gets crowded. The toolbar keeps filter, parallel, New card,
  and Import.

## [0.5.1] — 2026-07-17

### Fixed — light-mode ("day dojo") audit pass
- **Belt colours on cream.** The light theme re-tuned three of the five belt
  ranks but left `--belt-todo` and `--belt-queued` at their night-dojo values,
  so the Backlog and Queued column rules (and belt dots) were near-invisible on
  paper — Queued measured 2.2:1, below the 3:1 minimum for UI marks. Both are
  now tuned for cream (`#6E6656` / `#7A6E52`) in `public/style.css`; the site
  stylesheet gained the matching `--belt-todo` (it already had queued).
- **Dark "ink slab" blocks that aren't agent output.** The Import FORMAT
  reference (`.fmt-example`) and the empty-board `$ claude` example
  (`.empty-prompt`) reused the always-dark agent-output slab, so they rendered
  as heavy black boxes on the cream page. In light mode they now sit on a paper
  surface with ink text, reading like inline code blocks. The drawer transcript
  keeps its dark slab — that one really is agent output.
- **Transcript text that used theme-flipping tokens.** In the (always-dark)
  drawer transcript, user echo lines (`.t-entry.user`) used `var(--accent-ink)`
  and markdown links used `var(--accent)`; in light mode both flipped to a dark
  red on near-black (~2.3:1 / ~3.0:1). They now hardcode the slab-safe coral
  like their sibling entry colours (~6.2:1 / ~4.7:1).
- **Faint form placeholders.** `input/textarea::placeholder` dropped to ~4.2:1
  on paper because of an `opacity: 0.8`; now `opacity: 1` (~6.7:1).
- **Invisible "you" chat bubble.** The Sensei chat user bubble carried only an
  8%-tint fill that vanished on cream; it now gets an accent right-edge, so it
  stays marked in both themes.
- **Barely-visible text selection.** `::selection` reused the 8% accent wash;
  a dedicated per-theme `--selection-bg` now gives a legible highlight on cream
  (app and site).

## [0.5.0] — 2026-07-17

### Added — no Mac sleep while cards run
- The board now keeps the Mac awake while agents are working: every agent
  process — running cards, Sensei reviews, ✨ draft runs — holds a
  `caffeinate -w <pid>` power assertion tied to its pid, so the machine can't
  idle-sleep (or spin down disks) mid-task and the assertion vanishes the
  moment the agent exits — even across a server restart. Toggle in ⚙ Settings
  ("keep Mac awake while cards run", on by default).
- The agent-free gaps are bridged by a timed assertion too: post-run finalize
  (PR push, notifications, the Sensei handoff) after the last card exits, and
  subscription cooldowns while cards sit queued — otherwise the reset timer
  can't fire on a sleeping Mac and the queue parks all night.
- The display still turns off as usual. Note a closed lid on battery still
  sleeps — macOS doesn't let userland override that.

## [0.4.2] — 2026-07-17

### Changed — marketing site replica no longer drifts
- The landing page's "live board replica" (`site/index.html`) is now generated
  from `site/board.data.json` by `site/build.js` (`npm run build:site`) instead
  of being hand-copied from the app's board. The generator emits the app's real
  card/column classes and **fails the build** if any of them stop existing in
  `public/style.css`, so the replica can't silently fall out of sync as the
  product evolves (docs/ui-ux-review.md §6). The site stays fully static — the
  script writes plain HTML that Vercel deploys as-is, no build step required.

## [0.4.1] — 2026-07-17

### Fixed — board update check
- ⬆ Update no longer fails with "no such ref was fetched" when the clone sits
  on a merged-and-deleted PR branch: the pull now names `origin main`
  explicitly instead of trusting the current branch's upstream.
- The update chip no longer advertises an *older* version (e.g. "v0.3.2
  available" on a v0.4.0 board): an update is offered only when origin/main's
  version is actually newer than the local one.
- Status line decluttered: "kungfu v0.4.1 · ● claude 2.1.212 ↑ update · ● gh"
  — the "on your subscription" filler moved into the tooltip and the CLI's
  parenthetical name is dropped.

### Added — the UI/UX review pass (docs/ui-ux-review.md, all sections)
- Every API call now has an error path: failures surface as toasts, the boot
  sequence shows "contacting the dojo…" and a real error + retry state instead
  of a blank page, and a ⚡ reconnecting chip appears whenever the live SSE
  feed drops (the board refetches when it returns).
- Keyboard-first accessibility: cards and skill chips are focusable and
  operable with Enter/Space, modals and the drawer have dialog semantics
  (role, aria-modal, labelled titles), Escape closes the topmost surface,
  focus is trapped inside open overlays and returned to the trigger on close,
  the tab bar is a real tablist with arrow-key navigation, and the app has a
  skip link. The priority square now carries screen-reader text (and P3 gets a
  distinct urgent ring).
- Phones are first-class: the board stacks to a single column below 700px, a
  "column" select in the drawer moves cards anywhere (drag-and-drop has no
  touch equivalent), quick actions and the theme toggle grew to touch-target
  size, header counts stay visible on small screens, and column heights use
  dvh so iOS Safari stops jumping.
- Board search: a ⌕ filter box in the toolbar matches title, prompt, repo
  path, model, agent, and skills.
- Styled confirm/alert dialogs replace every native confirm()/alert();
  approving a card (quick ✓, drawer, or drag-to-Done) now asks first, and
  destructive confirms are visually marked.
- Sign out button in Settings (shown when the token gate is active) plus a
  /logout route; the login page now honors the saved theme and the OS
  preference, shows a copyable token-generation command, and rate-limits
  wrong-token attempts with visible feedback.
- A minimal service worker makes "add to home screen" a real PWA: network-first
  (frontend still serves fresh from disk), cached shell only as an offline
  fallback, /api/ never intercepted.

### Fixed — the UI/UX review pass
- Unsaved Sensei-settings edits are no longer wiped by SSE refreshes mid-edit
  (dirty-check before repopulating the form).
- Transcript and chat streaming only auto-scroll when you're already at the
  bottom — scrolling up to read no longer teleports you back down.
- Import feedback errors render in the error color instead of success green.
- Closing the card modal (backdrop, Cancel, or Escape) with unsaved changes,
  discarding a drafted import, or closing the drawer with an unsaved prompt
  edit now asks before throwing your work away.
- Board rebuilds preserve column scroll positions and defer while a drag is in
  flight; the drag-over outline no longer flickers when crossing cards.
- Double-submit protection everywhere: quick actions, card save, import,
  suggestion approve/reject, Sensei chat (input disables while it thinks —
  each run is a paid call), follow-ups, and drawer actions disable in flight.
- The CLI/gh health line actually re-checks every 5 minutes, as its tooltip
  always claimed.
- The header's first count chip is labeled "Backlog + Queued" — what it
  actually shows.
- Default working directory and repos directory can now be cleared from
  Settings (empty field = back to defaults).
- Context % is computed against a named 200k window constant on card and
  drawer instead of a magic /2000.
- Activity-log timestamps include the date when not from today; cards and the
  drawer show created/updated relative times; the drawer's cwd badge reveals
  the full path on hover; the copied-resume badge no longer turns into a wall
  of text.
- Theme: first visit follows the OS color scheme, the toggle exposes
  aria-pressed, and the theme-color meta follows the active theme.
- Safety-critical permission copy (dontAsk/bypassPermissions) is inline text
  in the card editor and Sensei settings, not just a tooltip; worktree/PR
  behavior got inline hints too.
- The Manager tab is now "Sensei" everywhere — one name for one agent.

## [0.3.2] — 2026-07-17

### Fixed
- App icons and favicons regenerated from the transparent logo — no more white
  box around the robot in browser tabs and bookmarks. Home-screen tiles
  (apple/ms icons) get the app's dark background instead, since iOS renders
  transparency as black.

### Changed
- The board leads with the auto path: ⇪ Import is the primary toolbar button
  (＋ New card is the ghost fallback), the empty state shows the terminal
  prompt that creates cards ("create a kungfu todo for …") with Import/draft
  as the main button and hand-writing as the fallback, and the import modal's
  footnote mentions you can skip it entirely from any Claude Code session.

## [0.3.1] — 2026-07-17

### Fixed
- A permission-blocked card can no longer be misread as a subscription or model
  outage. Its error embeds the denied command, so a benign block on a command
  whose text contains a phrase like "rate limit" (or a model name) previously
  false-tripped the board-wide cooldown / model-fallback and requeued the card —
  an indefinite freeze. Blocked runs now bypass both detectors entirely.
- The Sensei reliably sees a block (a snapshot flag, not just error-text
  matching) and won't spend a retry re-hitting the same wall; the block also
  leads the card's error even when the run additionally reported an error.
- The blocked transcript note no longer renders a doubled ⛔.

### Changed
- Landing page leans into full-auto: the four forms are now say-it → Sensei
  routes → dojo runs itself → PRs arrive shipped, and the hero + import copy
  no longer read like you write and route cards by hand.

## [0.3.0] — 2026-07-17

### Added
- The kungfu-todo skill installs itself: every server start writes/refreshes
  `~/.claude/skills/kungfu-todo/` with the clone's real paths and port, so any
  Claude Code session can "create a kungfu todo" with zero setup. The ⚙ Settings
  Install/Update button remains as a manual repair hatch.

### Changed
- Landing page and README sell the skill properly (its own feature cell) and
  drop the manual `cp` install instructions.

## [0.2.9] — 2026-07-17

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
