# Working on Kungfu Kanban

Conventions for coding sessions in this repo:

- **Version + changelog discipline**: every meaningful change bumps
  `package.json` version (minor = feature, patch = fix) and adds a line under
  `## [Unreleased]` → move to a dated section when pushed. The in-app update
  check shows users the new version, so keep them honest.
- **The live server runs under launchd** (`com.kungfu-kanban`). Frontend files
  serve fresh from disk; server-side changes need
  `launchctl kickstart -k gui/$(id -u)/com.kungfu-kanban` — but NEVER restart
  while cards are running (check `/api/tasks` first; restarting orphans agent
  processes).
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
