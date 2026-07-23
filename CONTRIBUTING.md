# Contributing

Kungfu Kanban is **open source and open to contributions** — a personal tool
whose garage door is open, and now there's a stool by the workbench if you want
to pull it up. The code is MIT-licensed and public so you can read it, learn
from it, fork it, and — increasingly — help shape it.

There are three things this project is opinionated about, and knowing them up
front saves everyone wasted work. It stays **single-user and local-first**, it
carries **one runtime dependency on purpose**, and it **executes code on your
machine** — so security is load-bearing, not decorative. Contributions that
respect those three land easily; contributions that fight them are a harder
conversation. More detail below.

## What's welcome

- 🐛 **Bug reports and fixes** — genuinely appreciated. File an issue with repro
  steps, or send a focused fix. (Poetic justice: issues on this repo get pulled
  onto the board via *⇣ From issues* and worked by the very agents you're
  reading about.)
- ✨ **Features** — yes, really. Open an issue or discussion first so we can
  agree on shape before you write code — not as a gate, but as the courtesy that
  stops you building something that won't land. Small and focused beats large
  and sweeping.
- 📝 **Docs, tests, and polish** — README fixes, clearer error messages, a
  regression test for something flaky, an accessibility improvement. Low-risk,
  high-value, always welcome.
- 🔒 **Security reports** — see [SECURITY.md](SECURITY.md). Privately, please —
  never in a public issue.
- 🍴 **Forks** — take it, rename it, make it yours. No permission needed, and a
  fork that goes its own direction is a feature, not a fork in the road.

## In scope / out of scope

The clearest way to know whether an idea will land is where it sits relative to
the project's identity.

**In scope** — things that make the single-user, local-first board better:

- Better agent handling: model/effort routing, worktree and PR flow, the
  Sensei's review and merge logic, cooldown and fallback behaviour.
- Board UX: the card drawer, columns, drag-and-drop, keyboard access, mobile/PWA
  polish, day/night dojo.
- Resilience: recovery from restarts and crashes, offline handling, clearer
  failure states, better notifications.
- Import/export, scheduling, dependencies, skills discovery.
- Tests and docs for any of the above.

**Out of scope** — not because they're bad ideas, but because they'd make this a
different tool:

- **Multi-user / multi-tenant.** The whole design assumes one person, one
  machine, one folder of JSON. Accounts and roles unravel that.
- **A hosted version.** There is no SaaS and there won't be one; everything lives
  on your own machine by design.
- **API-key or third-party model providers.** Cards run on your Claude Code
  subscription login on purpose — the runner deletes `ANTHROPIC_API_KEY`
  deliberately. No per-token billing, no key management.
- **A database.** State is flat JSON files in `data/`. That's the point — you can
  read it, diff it, back it up with `cp`.
- **Billing, teams, or an org layer.**

That multi-tenant / hosted / API-key / billing version *existed and was deleted
on purpose.* Proposals to bring it back will be declined — warmly, but firmly.
If you want that tool, a fork is the honest path and you have my blessing.

## Three ways to get a PR bounced (and how to avoid them)

None of these are traps; they're just the places where a well-meaning PR can do
real harm, so they get extra scrutiny.

1. **A new runtime dependency.** `express` is the only one this project carries,
   and that's a selling point, not an oversight. If your change wants another,
   open an issue first and make the case. An unexplained `package-lock.json` diff
   is the fastest way to get a PR closed without a second look.

2. **Touching security-sensitive code without a heads-up.** This board runs code
   on the user's machine, so a subtle change to the wrong spot is a real
   user-harm vector. Flag it in your PR if you touch any of:
   - the loopback-only bind and the token gate (the refusal to bind wider
     without a token, the timing-safe token compare),
   - the deletion of `ANTHROPIC_API_KEY` in the runner,
   - subprocess spawning — everything uses `execFile` with argument arrays, **no
     shell interpolation**, ever,
   - repo-path validation against the scanned allowlist,
   - client-side escaping (`esc()`) and the HTML-escape-before-markdown render.

   See [SECURITY.md](SECURITY.md) for the model these protect.

3. **An unexplained workflow-file or lockfile change.** Changes under
   `.github/workflows/` and to `package-lock.json` get read closely. If your PR
   needs one, say why in the description.

## If you do send a PR

- **Fork it.** No one but the maintainer has write access, and the maintainer is
  the only one who merges. Every PR is read diff-by-diff before it lands.
- **Open an issue first for anything non-trivial.** Bug fixes with a linked issue
  and focused features that were discussed first have the smoothest path.
- **Run `npm test` before you push, and keep it green.** It's `node --test` — no
  setup, no config, just Node. Every bug fix should ship with the regression test
  that would have caught it.
- **CI on fork PRs needs maintainer approval first.** GitHub holds Actions runs
  from outside contributors until a maintainer approves them, so don't be alarmed
  if the `test` check sits pending for a while — that's expected, not a rejection.
  The suite only runs `node --test` in GitHub's sandbox; it never touches your
  machine or any real `data/`.
- **Small and focused beats large and sweeping** — easier to review, easier to
  accept, and much easier to say yes to.
- **Security issues never go in a public issue.** Use GitHub's private
  vulnerability reporting (Security tab → "Report a vulnerability") — see
  [SECURITY.md](SECURITY.md).

There's no support SLA and no promised response time — this is one person's
workshop, now with visitors welcome. Be patient, be kind, and thanks for
pulling up a stool.
