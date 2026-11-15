# Troubleshooting

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
- **A card keeps asking you to approve a command** — cards run headless, which
  has no approval prompt, so replying "yes" can't grant a tool permission. A
  card whose mode won't allow a command (often a build/test that needs to leave
  the Bash sandbox) now lands **failed-in-review** with the reason. Raise the
  card's **Permissions** (the drawer's `perms` select) to `bypassPermissions`,
  or add an allow-rule in `.claude/settings.json`, then re-run.

---

[Back to the docs index](README.md)
