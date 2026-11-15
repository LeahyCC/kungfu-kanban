# The board

Columns: **Backlog → Queued → Running → Review → Done**

- **＋ New card** (or drag an existing card to **Queued**, or ▶ Run in the card
  drawer) launches it.
- **parallel** (toolbar, 1–8, default 2) caps concurrent sessions so you don't burn
  subscription rate limits; extra launches wait in Queued and start automatically as
  slots free up.
- Click any card for the **drawer**: live transcript, token/turn stats, and a
  `claude -r <session-id>` command to resume that session in your terminal.
- Finished runs land in **Review** (with a vermillion error stripe if they failed).
  **✓ Done** ships them — hanko seal included.
- If the server restarts mid-run, orphaned "running" cards are recovered into Review.
- **⚙ Settings** (toolbar): default working directory, repos directory, ntfy
  topic, macOS notification toggle, and Done-column archiving (see below).
- **☀ / ☾** toggles the day/night dojo. Night is the default.
- The toolbar shows live **system status**: green dots when the `claude` CLI and
  `gh` auth are healthy, red with a plain-English warning when they're not.
- The **⛽ usage chip** shows output tokens burned in the rolling 5-hour limit
  window across ALL Claude Code activity on the machine (board + terminal),
  computed from the local session logs. Set a budget in ⚙ Settings to turn it
  into a % meter (amber ≥70%, red ≥90%); the full in/out/cache/per-model
  breakdown lives in ⚙ Settings.
- The drawer shows **The work** — the card's prompt, editable in place — and
  running cards report live output tokens and **session context usage** (ctx %).
- Cards with a PR get **⇉ Merge PR / Close PR** buttons in the drawer — merging
  happens via `gh` and stamps the card Done on the spot.

## Built-in terminal (⌘J)

**▸\_ Terminal** in the toolbar (or ⌘J, or `t` in the command palette) opens a real
shell at the bottom of the board — your `$SHELL` started as a login+interactive
shell, so `~/.zshrc` and `~/.zprofile` load exactly as they do in your own terminal:
prompt, aliases, plugins, colours. It is a genuine pty, so job control and
full-screen TUIs (vim, lazygit, `claude -r <session-id>`) work, and resizing the
panel resizes the shell.

**Each card has its own terminal too.** ▸\_ Terminal in a card's drawer opens a shell
in _that card's_ working tree — the git worktree the agent ran in when the card used
one, not the parent repo — so `git diff`, the tests, and `claude -r <session-id>` all
land where the work happened. The tree's path shows in the panel bar. One shell per
card: reopening the card reattaches to it, ⏻ kill ends it and gives you a fresh one.

Sessions belong to the **server**, not the tab. Close the panel, reload the board,
or pick it up on your phone over Tailscale — `npm test` keeps running and the panel
reattaches with its scrollback. The panel bar holds one tab per shell (＋ for a new
one), **⏻ kill** ends the current shell for good, and **✕** just hides the panel.
Up to 8 sessions; a shell with nobody attached is reaped after 30 idle minutes.

No native module is involved: the pty comes from Python's standard library
(`lib/ptyhost.py`, spawned by `lib/pty.js`), so installing the board is still
`git pull && npm i`. It needs `python3` — stock on macOS with the Xcode command
line tools.

⚠ It is a shell on your Mac behind the same token as the rest of the board. That is
not a new trust boundary (anyone with the token can already run a card at
`bypassPermissions`), but it is a much more direct one — turn it off in
**⚙ Settings → System → built-in terminal** if you'd rather not have it. Turning it
off also kills any sessions already open.

## Archiving old Done cards

The Done column would otherwise grow forever, so a daily sweep moves cards out
once they've sat in Done longer than `settings.archiveDays` (default 7,
measured from `finishedAt`, falling back to `createdAt`). Archived cards are:

- appended as full JSON to `data/archive.jsonl` (one line per card), and
- removed from `data/tasks.json`, with their `data/transcripts/<id>.jsonl` file deleted.

The sweep runs once at server startup and every 24h after that. Set
**Archive "done" cards after (days)** to `0` in ⚙ Settings to turn it off;
archived history in `data/archive.jsonl` is never deleted automatically.

## Follow-up prompts

Open any card that has run and type in the **follow-up box** under the transcript
("fix the bug where…", "also add…"). The run **resumes the same CLI session**
(`claude -r`), so the agent keeps its full context — and for worktree cards it
re-enters the original worktree, so a follow-up push updates the existing PR.
Follow-ups respect the parallel cap and queue like any run; the follow-up text is
appended to the card's prompt so Sensei reviews and retries see it.

---

[Back to the docs index](README.md)
