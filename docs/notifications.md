# Notifications

When a card lands in **Review** (or fails), you get notified. User-stopped runs
don't notify.

## macOS (on by default)

Fires via `osascript`. Toggle in ⚙ Settings. If nothing appears, check System
Settings → Notifications → allow notifications for "Script Editor" / your terminal.

## Phone (ntfy)

1. Install the **ntfy** app ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
   [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)) — no
   account needed.
2. Pick a long, unguessable topic name (ntfy topics are a public namespace — anyone
   who knows the name can read it): e.g. `kk-$(openssl rand -hex 8)`.
3. Put it in **⚙ Settings → ntfy topic** on the board.
4. In the ntfy app: **+ → Subscribe to topic** → same name.

Pushes include the card title, and tapping one opens the PR when there is one.
Because the topic is public-by-obscurity, keep card titles free of secrets.

**🔔 Test notification** (in ⚙ Settings) fires both channels on demand — use it to
verify the phone hookup. You can also watch the topic live at
`https://ntfy.sh/<your-topic>` in any browser.

## Error tracker

The board keeps a persistent log (`data/errors.json`) of every operational
error or block as it happens — permission stops, PRs opened against the wrong
base branch, PR-flow commit/push/create failures, PR conflicts past auto-fix,
launch failures, Sensei action errors, and subscription-limit cooldowns.
Repeats bump a counter instead of piling up rows, and entries auto-resolve
when the thing they describe later succeeds. A red ⚠ chip in the header counts
open entries; clicking it opens the tracker with per-entry ✓ resolve, links to
the card/PR, and an **"Ask the Sensei to fix these"** button (that one works
even with the Sensei switched off, since you asked for it — it comes back with
suggestions to approve). The Sensei sees
open entries every run and can `resolve_error` (mark one handled) or
`retarget_pr` (move a PR onto the right base branch via `gh pr edit --base`) —
it only fixes the operation (permissions, bases, re-runs), never the code.
API: `GET /api/errors`, `POST /api/errors/:id/resolve`,
`POST /api/errors/resolve-all`; a live `errors` SSE event keeps the chip honest.

---

[Back to the docs index](README.md)
