# Cards

## Card fields

| Field               | Maps to                      | Notes                                                                                                     |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Title               | —                            | shown on the card, PR title, notification text                                                            |
| Prompt              | the `claude -p` prompt       | what the agent should do                                                                                  |
| Working directory   | process `cwd`                | repo dropdown (scans the ⚙ Settings repos directory for git repos) or any path                            |
| Model               | `--model`                    | default / fable / opus / sonnet / haiku                                                                   |
| Effort              | `--effort`                   | default / low / medium / high / xhigh / max                                                               |
| Permissions         | `--permission-mode`          | `acceptEdits` (default), `auto`, `plan`, `dontAsk`, `bypassPermissions` — see [Security](security-notes.md) |
| Agent               | `--agent`                    | your custom agents from `~/.claude/agents/*.md`                                                           |
| Git worktree        | `--worktree kanban-<id>`     | isolates the run on its own branch                                                                        |
| Open PR when done   | post-run `gh pr create`      | requires worktree; see below                                                                              |
| Priority            | sort order (0–3)             | 2+ shows the vermillion square                                                                            |
| Acceptance criteria | review rubric                | what you (or the Sensei, when enabled) judge the finished card against                                    |
| Repeat              | schedule (interval or daily) | `6h` every 6 hours, `14:30` daily — see [Scheduled cards](#scheduled-cards)                               |
| Skills              | injected into the prompt     | pick from installed skills, or **✦ auto-select** to let the agent choose                                  |

## Skills & agents discovery

Auto-discovered at load, no config:

- Personal skills: `~/.claude/skills/*/SKILL.md`
- Plugin skills: every enabled plugin in `~/.claude/plugins/installed_plugins.json`
  (their `skills/` and `workflow-skills/` dirs), namespaced `plugin:skill`
- Agents: `~/.claude/agents/*.md`

## Dependencies

Give a card a `deps` list — other card ids it must wait for — and it stays in
**Backlog** until every dependency is Done (approved or its PR merged); the
runner then launches it automatically. Columns lay chains out in run order and
dependency badges show unmet-prerequisite depth. The Sensei can chain a
multi-card plan itself: `create_task`/`update_task` accept exact card titles
and ordinals (including cards created earlier in the same batch), not just
ids, reusing the importer's title resolver — unresolvable entries surface as
`⛓ unresolved dep` instead of silently dropping the chain. Import markdown sets
the same thing with the `after` key (see [Importing cards](importing.md)).

## Scheduled cards

Give a card a **Repeat** value in the editor to run it on a schedule:

- `6h` (or `6`) — every 6 hours (fractional hours like `0.5h` are allowed)
- `14:30` — daily at 14:30 (24-hour local time)

The server checks once a minute. When a card is due, it's **cloned into a fresh
one-shot card** (with no schedule of its own) that's launched via the normal
runner — so clones respect the **parallel** (maxConcurrent) queue and flow
Backlog → Running → Review → Done like any other card. The scheduled card itself
stays in **Backlog** carrying a `⏱` badge and never moves columns on its own;
drag it elsewhere and it stops firing until it's back in Backlog. Clear the
Repeat field to turn scheduling off.

## Standing conventions in every card prompt

`lib/runner.js` appends these to each card's prompt (after the card's own text):

- **UI verification**: UI changes must be proven in a real headless browser
  (`npx playwright`), not code review alone.
- **Foreground commands**: builds and tests run in the foreground with a
  600000 ms timeout. Nothing is left running in the background, since the
  session ends when the turn does. A command that can't finish in 10 minutes
  is not run and is reported instead.
- **Published files**: a worktree card with `publishes` is told which file(s) it
  must write and that the board publishes them as contracts when it finishes.
- **No python on Windows**: on Windows, the board checks once (`where.exe`,
  never running python) for a real interpreter outside `WindowsApps`. If none
  is found it adds a line telling agents not to call `python` or `python3`.

---

[Back to the docs index](README.md)
