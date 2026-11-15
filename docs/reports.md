# Reports

## Shadow model routing (optional, Jev)

With `KFK_TYPESAFE_KEY` in the server's environment, each card's first run also
asks [TypeSafe](https://docs.typesafe.ai)'s Jev classifier how hard the card is
and records the model that difficulty would pick (`haiku`, `sonnet` or `opus`) on
the card as `jevRoute`, along with the score, Jev's confidence, and the model
version that answered. The call is pinned to `jev-1.13.0` so the score bands
stay put. A score outside 0 to 2 is ignored and asked again on a later run.
**Nothing is routed:** the card still runs on its own model. The call is in
the background and never delays a launch.

`npm run jev-report` lists Jev's pick, confidence, and version next to the
model each card actually ran on, its cost and its outcome, so you can see
whether routing by it would save money before switching anything on. The
card's title, prompt and acceptance criteria
are sent to TypeSafe; leave the key unset to keep it off. The board reads its own
`KFK_TYPESAFE_KEY` rather than the SDK's usual `TYPESAFE_API_KEY`, so having a
TypeSafe key set for other work never turns this on by accident.

## Flow numbers (`npm run flow-report`)

Every status change goes through `lib/transitions.js`, which records a few
facts on the card as they happen. Cards from before this existed simply lack
them.

| Field | Meaning |
| --- | --- |
| `firstQueuedAt` | ISO time of the first entry into Queued. Written once, never overwritten |
| `firstStartedAt` | ISO time of the first entry into Running. Written once, never overwritten |
| `queuedAt` | ISO time of the latest entry into Queued, for information. Re-parks by the board (cooldown, offline, model fallback, logged-out CLI) do not move it |
| `doneAt` | ISO time a person or the Sensei last marked the card Done (drag, PATCH, `approve_task`). Not set when the PR merging is what moved the card to Done |
| `followUps` | How many follow-up messages the card has actually resumed on (drawer or Sensei `followup_task`), counted when the resume starts. The board's own CI fixes are not counted |
| `sendBacks` | How many times a card in Review or Done went back to Queued or Running instead of being finished: Sensei `reject_task` / `requeue_task`, a drag back, a re-run. Follow-ups and the board's own cooldown / offline / model-fallback re-parks are not counted |

The counters only exist once they go above zero, so a blank cell in the report
means "none recorded", which is zero for a recent card and unknown for an old
one.

`npm run flow-report` reads `data/tasks.json` and `data/archive.jsonl` (or
`KFK_DATA_DIR`) without touching them, and prints one row per card: its status
(`error` only for a card still in Review with an error; otherwise the real
status), queued wait (`firstStartedAt` minus `firstQueuedAt`: how long the card
waited before any work began, across re-parks and re-runs), whether it had
dependencies, follow-ups, send-backs, and done to merged (`prMergedAt` minus
`doneAt`). Done to merged only exists for cards approved before their PR
merged; a card the merge itself moved to Done has no `doneAt`, so the cell is
blank. Cards that never queued (started straight from Backlog), or that
predate `firstQueuedAt`, have a blank wait. The last line gives the card count,
how many cards carry each field, and the median queued wait and done-to-merged
time. It is the "before" picture for starting a card ahead of its dependency.

---

[Back to the docs index](README.md)
