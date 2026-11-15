# The Manager (the Sensei)

An LLM manager — itself a `claude -p` structured-output call on your subscription —
that triages new cards (model/effort/skills/priority routing), dispatches queued
work, reviews finished cards against their acceptance criteria, and answers you in
chat ("plan the auth refactor into cards", "what's blocking?").

**Off by default** (since 1.26.0). Most people drive this board from a Claude
Code session, and that session is the manager: it writes the cards, launches
them, reads the PRs and merges them. A Sensei working underneath it pays twice
for the same fix and can merge a diff nobody read. So nothing below happens
until you tick **Sensei enabled** in the Manager tab; everything in this section
then works exactly as described.

While it is off it is not deaf: a message **you** send still gets an answer —
the chat box, the rail's Ask box, ⇪ Split into cards, and 🥋 Ask the Sensei to
fix these all work. It just answers and proposes. Nothing it suggests executes
without your ✓, whatever autonomy it was left on, and no card finishing, new
card, settled PR or interval tick starts a run.

Existing boards keep whatever is in their `data/settings.json` — this default
only applies to a fresh one. Untick the box to turn it off on a board you have
been running.

**Autonomy ladder** (Manager tab):

| Level                 | Can do without you                                             |
| --------------------- | -------------------------------------------------------------- |
| `suggest` _(default)_ | nothing — every action waits for your ✓                        |
| `semi`                | create / route / run cards; approve-reject verdicts still wait |
| `auto`                | everything, within guardrails                                  |

Deleting cards is never available to the manager, at any level.

**Act without asking** (under the ladder): the four verdicts `semi` holds back —
merge PR, approve, retry, follow-up — can each be released on their own, so
"merge green PRs yourself but ask before approving" no longer means jumping all
the way to `auto`. All unticked by default, which is the `semi` above; the group
is inert on `suggest` (holds everything) and `auto` (holds nothing).

**Triggers:** on task finish (review it), on new card (triage it), every N minutes
(0 = off), and chat. Each trigger is one manager invocation — mind your rate limits
before enabling the interval.

**Guardrails:** max launches/hour (default 10), max retries/task (default 2 —
rejected cards re-run with the manager's feedback appended to the prompt), and a
**permission ceiling** (default `acceptEdits`) the manager can't assign beyond.
Guardrail-blocked actions become suggestions instead of executing.

**Suggestions clean themselves up.** A suggestion disappears as soon as approving
it would do nothing: its card moved on, an `update_task` / `retarget_pr` card is
done (or the PR merged or closed), or the error a `resolve_error` names is
resolved. This happens live when a card changes status or an error resolves, not
only on page load. A Sensei run error ("Manager run errored: …") resolves itself
when a later Sensei run finishes cleanly.

**Management style:** freeform standing instructions ("prefer haiku for docs tasks",
"never auto-approve migrations") — no code changes needed.

The manager's own model/effort (default opus/medium) are configurable. The
**Sensei enabled** checkbox is what switches the whole thing on; it starts
unticked.

---

[Back to the docs index](README.md)
