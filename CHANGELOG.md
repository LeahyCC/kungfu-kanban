# Changelog

All notable changes to Kungfu Kanban. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver-ish —
minor bumps for features, patch bumps for fixes. The board's status line
compares your clone against `origin/main` and offers a one-click update.

## [Unreleased]

### Added
- Hands-off PR pipeline: the goal is card → PR → green → merged with no
  human in the loop. Failing checks on a clean PR now get an automatic fix
  before any verdict — the watcher resumes the card's own session with the
  failing-check names and instructions to pull the logs (`gh pr checks`,
  `gh run view --log-failed`), fix, and push (max 2 attempts per PR, refilled
  only by a new push so a flapping check can't hand out unlimited launches;
  no Sensei retry burned; explicitly told to stand down when the failure is
  CI infrastructure like billing/runner errors). While
  any PR's checks are still running the watcher re-polls every 60s instead
  of waiting out the full sweep interval, so a green PR merges about a
  minute after CI finishes rather than up to ten. Repos with no CI at all
  are stamped `noCi` after a 10-minute grace window — the Sensei may then
  merge on diff review alone instead of waiting forever for checks that
  will never report ("no CI" badge on the card). The Sensei is never
  invoked while a fixer is active in the card's worktree, so two agents
  can't collide on one branch.
- A ⏹ stop button next to the Sensei's "thinking…" pill kills the in-flight
  run (`POST /api/manager/stop`) — the escape hatch for a misclicked trigger.
  The cancelled run's output is discarded, any coalesced follow-up invocation
  is dropped, and the chat notes the stop. Tokens already spent are gone;
  the point is that no half-baked decision gets applied.
- Lost-internet handling: a card that dies on a connectivity error is
  requeued instead of failed (confirmed by a live DNS probe so a card whose
  own tests hit ECONNREFUSED still fails normally), auto flow pauses, and a
  📡 offline header chip shows until a 30s probe loop finds the connection
  back — then queued cards relaunch. The chip also reflects the browser's
  own offline state, and API toasts say "offline — check your connection"
  instead of a raw fetch error.

### Fixed
- The PR-loop test suite (`test/prwatch.loop.test.js`) no longer inherits the
  developer's global `commit.gpgsign` — its fixture repo forces
  `commit.gpgsign=false`, so an expired or missing local GPG key can't fail
  the setup `git commit` and take all six loop tests down with it (they were
  environment-dependent, never a code fault).
- `requeue_task` on a running or stopping card is now a success no-op
  instead of an `error: not requeueable (running)` — the card was mid-flight
  between the snapshot the Sensei acted on and this call, a stale-snapshot
  race, not an operational failure. Brings requeue into line with its
  siblings `run_task`, `approve_task`, and `merge_pr`, which already short-
  circuit the two transient states the same way (#94).
- The `release-check` CI guard no longer fails every single PR. It demanded a
  `## [X.Y.Z]` section matching `package.json` for any untagged version, which
  contradicts the repo convention of bumping the version on every change and
  accumulating entries under `## [Unreleased]` until the release card renames
  the section — so 100% of PRs went red on it and needed a human. Naming the
  section for the version is now what marks a release (and still triggers the
  full merged-PR reconciliation); an in-flight bump only has to describe
  itself under `## [Unreleased]`, with a clear failure when that section is
  empty or missing.
- A push to an existing PR now clears the stored check rollup instead of
  leaving results that never saw the new code — a follow-up or conflict fix
  could otherwise be merged on stale green checks, or rejected for failures
  it had just fixed. The card reads as "waiting for checks" until CI
  re-reports.
- Opened PRs are now actually reviewed for conflicts and CI: the PR watcher
  re-invokes the Sensei once a review card's checks settle (the finish-time
  review runs before CI has reported anything, and nothing ever handed the
  card back — green PRs sat unmerged until a human looked). Merge-conflict
  state is now tracked on the card too (`prChecks.conflicting`): the board
  badges ⚔ conflicts, the transcript notes it once (with a notification when
  auto-fix is off), and the Sensei sees it and refuses to merge a conflicting
  PR even when CI is green.
- The attention popup's Approve all / Reject all now cover permission-blocked
  cards, not just Sensei suggestions — a popup of only blocked cards used to
  make both buttons silent no-ops. Approve all bypass-&-re-runs the blocked
  cards after one batch confirm; Reject all acknowledges and dismisses them
  (new acknowledge-only `permissionBlocked: null` PATCH).
- Cards running at bypassPermissions no longer land in Review as
  "Blocked on permission" when a command merely matched an explicit deny
  rule in `.claude/settings.json` — at bypass there is no mode left to
  raise, so the old advice (and its Bypass & re-run button) looped forever.
  Deny-rule denials are now a transcript note; the blocked message at lower
  modes also explains that deny rules win at every mode.
- CI now fails a release PR whose changelog under-reports what shipped: a
  version bump must cite every non-dependabot PR merged since the previous
  tag (`scripts/check-release.js`). 1.1.0 first went out missing five PRs;
  this stops that recurring.

## [1.1.0] — 2026-07-20

### Added
- A header 🔔 chip counts Sensei suggestions awaiting your verdict plus cards
  stopped on a permission block, and opens a "Needs your attention" popup
  with per-item and batch Approve/Reject and an Open-card shortcut. It
  auto-opens once on the 0→N transition and never nags after that. (#83)
- Blocked cards get a one-click "⚡ Bypass & re-run": it re-runs the card
  with `bypassPermissions` instead of making you raise the permission mode
  and re-launch by hand. This is a deliberate human override, so it isn't
  clamped by the manager's permission ceiling the way auto-picked modes are. (#87)
- When suggestions are being held by the hourly launch cap, the attention
  popup shows a notice with an "Approve-all now" path and a "Raise cap"
  control, instead of leaving them silently stuck. (#88)

### Changed
- The repos directory now auto-scans the common dev-folder conventions
  (`code`, `src`, `projects`, `Documents/Code`, …) and picks whichever holds
  the most git repos, falling back to `$HOME` — instead of defaulting to one
  person's `~/Documents/Code/Git`. It's configured by whoever runs the board,
  never baked in. (#82)
- Upgraded the one runtime dependency from Express 4 to Express 5. (#59)
- The README now opens with a dark-mode board screenshot that adapts to the
  reader's GitHub theme. (#80)

### Fixed
- Stale Sensei suggestions are now auto-pruned instead of piling up.
  Takes effect after the next board restart on servers already running;
  fresh installs get it immediately. (#81)

### Security
- Transient browser-verification screenshots and `.playwright-mcp/` output are
  gitignored, so a board screenshot — which can contain private card content —
  can never ride along in a PR. (#84)

### Chore
- CI: bumped `actions/checkout` to v7. (#58)

## [1.0.1] — 2026-07-20

### Added
- `test/server.integration.test.js` boots the real server as a child process
  to cover route-level regressions unit tests miss: validation coercions,
  the auth gate, and status-code contracts. `parseSchedule`/`scheduleDue`
  moved to `lib/schedule.js` so they're directly unit-testable. Every
  spawned server gets its own `KFK_DATA_DIR` (a fresh temp directory), an
  env override honored by `lib/store.js` and everything that derives its
  data paths from it, so the integration suite never touches this
  checkout's real `data/`.
- Split the parser smoke test into per-module suites under `test/` with
  decision-table coverage of the importer, deps, models, cooldown, prwatch,
  runner, errlog, auth, and skill install/status logic.
- CI now runs the suite on ubuntu-latest and macos-latest (matrix) and prints
  `node --test` coverage on every run (no threshold gate yet).
- Open-source contribution gating: CODEOWNERS, dependabot, contributor docs.
- Release tags + GitHub Releases published (v0.13.0–v1.0.0 backfilled), and
  required for future releases.

### Changed
- README: badge row (CI, latest release, MIT license), hero image slot, and a
  tighter positioning paragraph up top for people landing cold.
- The humanizer skill (MIT, vendored at `skills/humanizer/SKILL.md`) now ships
  with the board alongside ponytail: installs to `~/.claude/skills` at boot,
  pre-selects on new cards, and the kungfu-todo template tells agents to apply
  it to PR titles, PR descriptions, and result summaries.
- Mobile layout fixes: site manual overflow, masthead CTA wrap, app header under 360px.
- site: humanizer pass
- docs: humanizer audit — already clean (README.md, CONTRIBUTING.md, SECURITY.md, lib/skill.js template strings)
- site: accuracy pass on the manual/FAQ/llms.txt — dependency chains, group
  batching, and the Sensei's diff review/merge/follow-up/error-tracker
  powers were live since 0.12–0.14 but undocumented on kungfu-kanban.com.
- site: added `/compare` (honest comparison vs Vibe Kanban, Conductor, and
  Crystal/Nimbalyst) and `/docs` (linkable reference sections — import
  format, the Sensei's actions/autonomy, dependency/merge-gate semantics,
  groups & lanes), wired into nav, sitemap, and structured data.

## [1.0.0] — 2026-07-20

Kungfu Kanban hits 1.0: the board now runs its whole intended loop. 0.13.0
cleared a full quality audit — atomic state writes, safe restarts,
merge-gated dependency chains, hardened import/PR plumbing. 0.14.0 closed the
loop on the Sensei — it reviews the actual PR diff, merges green PRs within
its autonomy setting, and sends precise same-session follow-ups instead of
blind retries, with every PR gated by CI. 0.15.0 made batched work flow as
grouped lanes with one-click queueing and group-complete notifications. 1.0.0
declares the surfaces stable: the import format, the HTTP API, the on-disk
data files, and the generated skill.

## [0.15.0] — 2026-07-20

### Added
- Grouped cards now run one lane at a time: at most one card per group is
  in progress at once, an in-progress group drains before a fresh one
  starts, and a manual run still bypasses the lane when you need it now.
- A queue-group button on group headers launches every backlog card in
  that group with one click, instead of queuing them one by one.

### Changed
- A group now sends a single notification when it completes instead of one
  per card, and the Sensei prefers finishing an in-progress group over
  starting a new one and reviews a completed group's cards as a batch.

## [0.14.0] — 2026-07-20

### Added
- The Sensei now pulls the actual PR diff (`gh pr diff`, capped and truncated)
  into its review context for cards under review, instead of judging only
  the agent's self-report — the two serious flaws a human caught in the
  0.13.0 batch were invisible in the self-report and obvious in the diff.
- The Sensei can now merge a card's PR itself (`merge_pr`), gated the same way
  as its other powers: a one-click suggestion under `suggest`, held for
  approval under `semi`, done alone under `auto`. It only merges when the
  card is in review, its PR checks are all green (no failing, no pending, no
  unknown/absent checks, right base), and it skips with a note otherwise —
  closing the gap where approve-without-merge left a "done" card still
  blocking its dependents. The 0.13.0 batch stalled at 14 finished cards and
  0 merges for exactly this reason; the human no longer has to be the merge
  button.
- The Sensei can now `followup_task` a review card: resume its own agent
  session with precise feedback instead of always `reject_task`ing into a
  full fresh run. Reserved for small, specific flaws (name the file, name the
  fix); `reject_task` still handles approach-level failures that need a
  restart. `run_task` on an already-running/stopping card is now a no-op
  instead of an error, matching the other stale-snapshot races.
- Import frontmatter now takes `queue: true` (alias `autoqueue`) to auto-launch
  every card in the file on import, instead of dropping them in Backlog where
  nothing picks them up. Chained cards (`after:`/`sequential:`) park in Queued
  and cascade automatically as their prerequisites ship.
- Every PR now runs the test suite in CI, so a red run is machine-checkable
  before the Sensei ever considers merging it.

### Fixed
- PR-watch conflict fixer no longer spawns against an already-resolved PR: the
  sweep re-checks state/mergeable right before creating the fix card, and the
  fixer prompt itself re-verifies and bails as a no-op if the PR turns out
  merged, closed, or no-longer-conflicting by the time it starts.

## [0.13.0] — 2026-07-19

### Added
- Stuck cards are now surfaced with a hung-agent watchdog, so a card whose
  agent silently stops making progress gets flagged instead of sitting idle
  forever.
- The SSE connection now sends a heartbeat ping, so the board recovers
  cleanly from flaky wifi/sleep instead of silently going stale.
- Imported cards are grouped by their import batch, making large imports
  easier to scan.
- Cards held back by an unmet dependency now show their held-until-merge
  state, and the previously-silent 20-dependency cap is now surfaced
  instead of failing quietly.
- A node test harness now covers the import/markdown parsers, catching
  parser regressions before they ship.

### Changed
- Dependent cards now release only once their prerequisite's PR has actually
  merged, instead of as soon as the card closes.
- Card drag focus and selection now survive live board re-renders instead of
  resetting.
- iOS PWA safe-area insets and the home-screen icon got a polish pass.

### Fixed
- A model-fallback retry storm, double-started runners, and double-fired
  card spawns are fixed — cards no longer race or duplicate their own runs.
- Data file writes are now atomic (write-then-rename, with a safe backup
  ordering), so a crash mid-save can no longer leave the board file missing
  or corrupt.
- The write API and auth checks are hardened against edge cases, and the
  import markdown parser no longer chokes on malformed input.
- PR-watch base detection, merge-notification spam, and dead PR watches are
  fixed.
- The usage scan no longer blocks the UI while it runs.
- The manager log and imported-inbox no longer grow unbounded.
- Failed inbox imports are now visible and won't duplicate on retry.
- Fixed the transcript markdown renderer, drawer/modal state bugs, and
  Sensei actions repeating themselves against stale state.
- Worktree cards now sync local main before launching, and base-branch sync
  no longer refuses to fetch into the currently-checked-out branch.
- Server shutdown now stops running agents and flushes state cleanly before
  exiting.

## [0.12.0] — 2026-07-19

### Added — ponytail ships with the board
- The [ponytail](https://github.com/DietrichGebert/ponytail) skill (MIT,
  vendored at `skills/ponytail/SKILL.md`) now installs to `~/.claude/skills`
  automatically at boot alongside kungfu-todo — every board gets the
  lazy-senior-dev discipline without a separate plugin install. The ⚙ Settings
  skill row shows and repairs both skills.
- New cards pre-select the ponytail skill in the card modal (first `ponytail`
  or `*:ponytail` match; deselect per card as usual).
- Skill filter box in the card modal — type to filter the skill chips by name
  or description; selected chips always stay visible.

### Added — Sensei-built dependency chains
- The manager's `create_task`/`update_task` deps now accept exact card titles
  and ordinals — including cards created earlier in the same decision — not
  just ids, reusing the importer's resolver. Unresolvable entries surface as
  `⛓ unresolved dep` instead of dropping the chain, and the manager prompt now
  tells the Sensei to chain multi-card plans itself.

### Changed
- Columns now lay dependency chains out in run order (unmet-prerequisite depth,
  then priority); dependency badges get a filled wash so chain links read at a
  glance.
- site: the landing page tells the frugality story — a full-width "Frugal"
  feature cell, an FAQ entry on token usage, an llms.txt fact, and a manual
  note; benchmark numbers attributed to ponytail's own measurements.

## [0.11.0] — 2026-07-18

### Added — auto error tracker: every error and block, logged and Sensei-fixable
- The board now keeps a persistent error tracker (`data/errors.json`): every
  operational error or block is logged automatically as it happens —
  permission stops, PRs opened against the wrong base branch (branch-guard
  failures like `source-must-be-staging`), PR-flow commit/push/create
  failures, PR conflicts past auto-fix, launch failures, Sensei action
  errors, and subscription-limit cooldowns. Repeats bump a counter instead of
  piling up rows; entries auto-resolve when the thing they describe later
  succeeds (clean re-run, green PR, merge, cooldown reset).
- A red ⚠ chip in the header counts open entries; clicking it opens the
  tracker with per-entry ✓ resolve, links to the card/PR, and one button —
  "Ask the Sensei to fix these" — that hands the open list to the Sensei.
- The Sensei sees open entries in every run and gets two new actions:
  `resolve_error` (mark an entry handled) and `retarget_pr`, which moves an
  existing PR onto the right base branch via `gh pr edit --base` — so the
  recurring "card agent opened the PR against main, CI demands staging"
  failure is a one-ask fix instead of a manual `gh` incantation. Its orders
  are explicit: fix the operation (permissions, bases, re-runs), never the
  code — failing tests keep flowing through normal review/reject.
- New API: `GET /api/errors`, `POST /api/errors/:id/resolve`,
  `POST /api/errors/resolve-all`; a live `errors` SSE event keeps the chip
  honest without polling.

## [0.10.0] — 2026-07-18

### Added — landing-site SEO overhaul (phase 0)
- `site/` now ships the full indexation kit: `robots.txt`, `sitemap.xml`, and
  `llms.txt` (an answer-engine summary of the product), plus a keyword-bearing
  title tag, tightened meta description, canonical URL, Open Graph / Twitter
  cards backed by a generated 1200×630 `og.png`, and JSON-LD structured data
  (`WebSite`, `SoftwareApplication`, `FAQPage`).
- `site/vercel.json`: 308 redirect `www.` → apex (removes the duplicate host
  Google was seeing) and long-lived cache headers for static assets.
- The four-forms numerals render via a CSS pseudo-element so contrast checkers
  stop scoring the intentionally hollow fill as low-contrast text; the hero
  image loads with `fetchpriority="high"`.

### Added — web analytics on the public landing site
- The marketing site (`site/`) now loads PostHog to measure real visitor
  behaviour — pageviews, scroll, and clicks — via the public project key.
- The board app itself stays **telemetry-free**: no analytics SDK, no phone
  home. A fresh clone runs fully offline with nothing reporting anywhere.

## [0.9.0] — 2026-07-18

### Added — human bottlenecks bubble up (🖐 blocks N)
- When queued work is held behind a card awaiting a verdict, the board now
  says so out loud instead of leaving the reason buried in a transcript:
  review cards that block queued dependents wear a `🖐 blocks N` badge
  (dependents + the releasing action in the tooltip), the drawer lists what
  they hold up, and a notification fires — "your verdict is the bottleneck:
  merge its PR / approve / fix to release" — once per landing (a re-run that
  lands in review again renotifies; no re-ping every sweep).
- The Sensei's snapshot carries `blocksQueued` with orders to review
  critical-path cards FIRST, and to open its reply with exactly what the
  human must click when releasing needs them (e.g. merging a PR).

## [0.8.1] — 2026-07-18

### Fixed — ↑ update button actually updates a Homebrew-installed CLI
- `claude update` refuses to self-update a brew-managed install — it answers
  "To update, run: brew upgrade claude-code@latest", and the button just
  displayed that text. The endpoint now recognizes the instruction and runs
  the exact prescribed brew command itself (arg-array `execFile`, formula
  name shape-checked, brew probed at its standard install paths since
  launchd's PATH lacks it), then reports the new `claude --version`.

## [0.8.0] — 2026-07-18

### Added — board-wide default permission mode
- ⚙ Settings gains **Default card permissions**: the mode pre-filled on new
  cards and applied to imports/Sensei-created cards that don't set one
  (`settings.defaultPermissionMode`, still `acceptEdits` out of the box).
  The Sensei's permission ceiling keeps clamping only the modes the Sensei
  itself chooses — the human's board default applies unclamped.

### Fixed — worktree cards no longer permission-block on reading their own repo
- Worktree sessions live inside the worktree, so the parent repo's paths were
  out of bounds: even a `Read` of the main checkout permission-blocked a
  headless card ("the agent needed to run Read …WEB-PARITY.md"). Launches and
  resumes now pass `--add-dir <repo>`, whitelisting the parent repo — the
  most common source of false permission blocks disappears without raising
  any card's mode.

## [0.7.0] — 2026-07-18

### Added — CI surveillance for card PRs (no more silently red PRs)
- The PR watcher now pulls every open card PR's **check rollup** each sweep
  (plus one quick sweep ~2 min after a card opens/updates a PR, so fast
  failures like branch guards surface in minutes): pass/fail/pending counts,
  the failing check names, and the PR's actual base branch land on the card as
  `prChecks`. Transitions log to the card transcript and notify once — a red
  PR doesn't re-notify every sweep, and recovery ("all green") is noted.
- Cards can declare the intended PR base: `base: staging` in the import
  frontmatter (field `prBaseBranch`). The PR flow opens PRs against it, and
  the watcher flags **wrongBase** when an open PR drifts from it — the fix for
  "source-must-be-staging"-style branch guards rejecting PRs into main.
- The Sensei sees `prChecks`/`prBaseBranch` in its snapshot with hard
  guidance: never approve while checks are failing, pending, or wrongBase;
  failing tests → reject with the check names (the retry's push updates the
  same PR); wrong base → set `prBaseBranch` and flag the human to retarget
  (`gh pr edit --base`).
- UI: `CI ✕ n` (red, failing names in the tooltip), `CI wrong base`,
  `CI … n` (running), `CI ✓` (all green) badges on cards, and a CI summary
  line in the drawer. The kungfu-todo skill and ✨ Draft prompt teach `base:`
  and warn that a card isn't shipped until its PR is 100% green.

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
