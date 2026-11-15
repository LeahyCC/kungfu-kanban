# Repo cards, real PRs

Give a card a working directory that's a git repo with an `origin` remote, check
**Git worktree** + **Open PR when done**, and run it. After the agent succeeds:

1. The worktree is located by asking git (`git worktree list`) for the branch
   named `kanban-<card-id>` — wherever the CLI put it.
2. Changes the agent left in tracked files are committed with the card title as
   the message (`git add -u`, so untracked files are never swept in; they are
   listed on the card instead). The repo's hooks always run. A hook that fails,
   or a commit that fails for any other reason, is logged with git's own output
   and the changes stay in the worktree; the flow carries on with the agent's
   own commits.
3. If the branch has no commits beyond the base (the branch your main checkout is
   on), the flow stops, so there are no empty PRs.
4. The branch is pushed to `origin` (hooks run here too). If the agent already
   opened a PR on the branch, that PR is attached to the card. Otherwise
   `gh pr create` opens one: title = card title, body = the agent's final
   report plus the acceptance criteria as a checklist.
5. The **PR link** lands on the card, in the drawer, and in your phone notification.

Every step logs to the card transcript (`⇡` lines). Failures (no remote, `gh` not
authed, push rejected…) log an `✕` line and leave the card in Review. The work is
still in the worktree, nothing is lost.

**One-time setup:** `gh auth login` (with push scope to the repos you'll use).

**Where worktrees live.** By default the card runs `claude --worktree
kanban-<id>`, which puts the worktree inside the repo at
`<repo>/.claude/worktrees/kanban-<id>` (the flag takes a name, not a path). To
keep them in one shared folder instead, set `worktreeRoot`:

```bash
curl -s -X PUT -H "Content-Type: application/json" \
  -d '{"worktreeRoot": "H:\\Git\\.worktrees"}' http://localhost:4747/api/settings
```

The board then makes each card's worktree itself at
`<worktreeRoot>/<repo folder>/kanban-<id>` on branch `worktree-kanban-<id>`
(forked from the local default branch) and runs claude inside it. The folder is
named for the card because the agent picks its branch later. Untracked files
listed in the repo's `.worktreeinclude` are copied in, as `claude --worktree`
does. A card that already has a worktree keeps using it. `~` is accepted; an
empty string goes back to the default.

**Processes left running.** When a worktree card's run ends (finished, failed or
stopped), the board kills whatever is still running inside its worktree, such as
a `next dev` the agent never stopped, and names each process on the card. A
board terminal open in that worktree keeps its processes. Cards cut off by a
board restart or crash are reaped when the board starts again. Cards without a
worktree run in your own checkout and are never reaped.

## PR watch: merged PRs ship, conflicted PRs self-heal

Every N minutes (⚙ Settings, default 10, 0 = off) the board checks each Review
card's PR via `gh`:

- **Merged** → the card moves to Done ("PR merged") and you get a notification.
  With cleanup on (default, ⚙ Settings), the board then kills processes still
  running inside the card's worktree, removes the worktree, and deletes the local
  and remote branch. It checks the branch tip landed on the base first; for a
  squash or rebase merge it trusts GitHub's MERGED state but keeps the local
  branch. The `worktree-kanban-<id>` branch the worktree started on goes too,
  when it has no commits beyond the base. If the folder survives the removal
  (Windows, with `node_modules` or `.next` briefly locked) and git no longer owns
  it, the board deletes it. Any cleanup failure is logged on the card and in the
  error tracker.
- **Closed without merge** → noted once on the card transcript.
- **Conflicting** (main moved under the branch) → with auto-fix on (default), the
  board spawns a **fix card**: a fresh agent run _inside the original worktree_
  that merges the base branch, resolves the conflicts preserving both sides, and
  pushes — updating the PR in place. Max 2 attempts per PR, one active fixer at a
  time; after that you get a "needs you" notification and it stops. Fix cards
  wear an `auto-fix` badge and flow through the normal columns, so the Sensei
  reviews the resolution like any other run.
- **Red CI** on an otherwise clean PR → with CI auto-fix on (default), the card's
  _own session_ is resumed with the failing logs, so no retry is burned. Max 2
  attempts. Failures the watcher has verified as infrastructure (billing,
  runners never starting) are never auto-fixed — no code change can fix those.

The two auto-fixes are separate switches in ⚙ Settings → System: pushing a merge
commit to your branch and sending an agent at your CI are different amounts of
trust, so you can keep either one without the other.

Keep local `main` pushed: agent worktrees branch from the default branch, so an
unpushed main is how you get avoidable conflicts in the first place.

---

[Back to the docs index](README.md)
