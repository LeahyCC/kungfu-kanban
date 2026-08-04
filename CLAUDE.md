# Working on Kungfu Kanban

Conventions for coding sessions in this repo:

- **Version + changelog discipline**: every meaningful change bumps
  `package.json` version (minor = feature, patch = fix) and describes itself in
  a **dated** section — `## [X.Y.Z] — YYYY-MM-DD`, written that way in the PR,
  not left under `## [Unreleased]`. The in-app update check shows users the new
  version, so keep them honest. If a card's prompt explicitly overrides this
  (e.g. a batch whose release card owns the version bump), the card prompt wins
  — three batch agents following this convention against explicit card
  instructions caused avoidable merge conflicts on 2026-07-20.
  **Releases are automatic since 2026-07-29**: merging to `main` runs
  `scripts/cut-release.js` (the `release` job in `test.yml`), which creates the
  annotated `vX.Y.Z` tag and the GitHub Release from that dated section. One
  merged PR, one release — no release cards. A PR that bumps no version, or
  leaves its notes under `[Unreleased]`, releases nothing and stays green;
  that silence is how 1.8.0 through 1.10.1 slipped out untagged before this
  existed, so `scripts/check-release.js` still audits PR citations at PR time.
- **The live server runs under launchd** (`com.kungfu-kanban`). Frontend files
  serve fresh from disk; server-side changes need
  `launchctl kickstart -k gui/$(id -u)/com.kungfu-kanban`. A SIGTERM/SIGINT
  handler in `server.js` stops any running cards and stamps them
  `error: 'interrupted by server restart'` (status `review`) before exiting, so
  a restart is safe even with cards in flight — but it still kills whatever
  those agents were mid-doing, so avoid restarting mid-run when you can wait.
  A hard kill (SIGKILL, crash) skips the handler; `lib/store.js`'s boot sweep
  applies the same error marker as a fallback.
- **Verify against the real server**: `TOKEN=$(cat data/auth-token)` then curl
  with `Authorization: Bearer $TOKEN`. The token gate reads per-request.
- **The kungfu-todo skill is generated** by `lib/skill.js` — edit the template
  there, never the installed copy; reinstall via ⚙ Settings or
  `POST /api/skill/install`.
- **No shell interpolation**: subprocesses use `execFile` with arg arrays.
  User-visible strings go through `esc()` client-side; markdown renders only
  after HTML-escaping.
- **`data/` is state, never committed.** `local/` and `.claude/worktrees/` are
  gitignored legacies/workspaces.
- Keep `main` pushed: agent worktrees base on the default branch; a stale
  origin causes avoidable PR conflicts.
- Every bug fix ships with the regression test that would have caught it.
- **UI changes are verified in a real browser, not by code review alone.**
  Prove the change in headless Chromium before calling it done. Quick visual
  proof from any directory: `npx playwright screenshot <url> out.png`.
  Scripted checks (clicks / console errors / computed styles):
  `npm i --no-save playwright` in the project at hand, then a small
  `require('playwright')` script; `npx playwright install chromium` once per
  machine if the browser binary is missing. (`npx --package playwright node
  script.js` does NOT work — modern npm puts the bin on PATH but sets no
  NODE_PATH.) `lib/runner.js` injects this convention into every card prompt
  and the Sensei withholds approval of UI diffs with no browser evidence.
  Playwright is deliberately **not** a dependency of this app — the npx and
  browser caches are per-machine, so nothing is baked into `npm install`
  (see PR protocol below for why).
- **PR protocol** — for every PR from a coding agent or human contributor.
  Lessons from PR #128 (2026-08-03), a vibe-coded PR that was right in spirit
  but needed rework on all four points:
  - **Date the changelog section in the PR itself** (`## [X.Y.Z] — YYYY-MM-DD`,
    per the version discipline above). Notes left under `[Unreleased]` merge
    green but release nothing — the bumped version slips out untagged, the
    exact 1.8.0–1.10.1 failure the auto-release exists to prevent.
  - **No install-time weight.** Nothing in `postinstall` that downloads
    browsers or binaries, and don't promote a devDependency to a dependency
    to make it ambient — `test.yml` deliberately keeps the Chromium download
    out of the `suite` job, and a postinstall silently re-adds it to every
    `npm ci` on every OS in CI. Prefer on-demand `npx`.
  - **No global env or resolution changes to serve one use case** (NODE_PATH,
    PATH, module paths injected into every spawned agent) — that leaks this
    repo's `node_modules` into unrelated projects as phantom dependencies.
  - **A UI change's test plan shows real-browser evidence** (screenshot or
    playwright check output), not just `npm test` passing.
  - **No AI attribution footers** (`Co-Authored-By: Claude …`,
    "Generated with Claude Code", or similar) in commit messages or PR bodies.
