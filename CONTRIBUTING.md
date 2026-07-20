# Contributing

Kungfu Kanban is **open source, closed contribution** — a personal tool whose
roadmap is "whatever its one user needs." The code is MIT-licensed and public so
you can read it, learn from it, and fork it into your own dojo.

**What's welcome**

- 🐛 **Bug reports** — genuinely appreciated. File an issue with repro steps.
  (Poetic justice: issues on this repo get pulled onto the board via
  *⇣ From issues* and fixed by the very agents you're reading about.)
- 🔒 **Security reports** — see [SECURITY.md](SECURITY.md). Privately, please.
- 🍴 **Forks** — take it, rename it, make it yours. No permission needed.

**What's probably declined**

- Feature PRs, refactors, and style changes — even good ones. If you think
  something belongs upstream, open an issue first so nobody writes code that
  won't land. Unsolicited feature PRs will likely be closed with thanks.

There's no support SLA, no roadmap, and no promise of responses — this repo is
one person's workshop with the garage door open.

## If you do send a PR

- **Fork it.** No one but the maintainer has write access, and the maintainer
  is the only one who merges.
- **CI on fork PRs needs maintainer approval first.** GitHub holds Actions
  runs from outside contributors until a maintainer approves them, so don't
  be alarmed if the `test` check sits pending for a while — that's expected,
  not a rejection.
- **Every PR gets read diff-by-diff** before it merges. Small and focused
  beats large and sweeping — it's easier to review and easier to accept.
- **The one-dependency footprint is deliberate**, not an oversight. `express`
  is the only runtime dependency this project carries on purpose. Proposing a
  new one? Open an issue or discussion first, before writing the PR. An
  unexplained `package-lock.json` diff or a workflow-file change is the
  fastest way to get a PR closed without a second look.
- **Run `npm test` before you push.** It's `node --test` — no setup, no
  config, just Node. Keep it green.
- **Security issues never go in a public issue.** Use GitHub's private
  vulnerability reporting (Security tab → "Report a vulnerability") — see
  [SECURITY.md](SECURITY.md).
