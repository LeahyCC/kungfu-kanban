# How the board saves tokens

A long Claude Code session gets expensive in a way that is easy to miss. Every
turn sends the whole conversation back to the model: the plan, and also every
file it read, every test log and every diff from the tasks it already finished.
By task six you are paying to re-read tasks one to five. Then the context fills,
the session compacts, and the plan you wrote at the start is the first thing to
go fuzzy.

Kungfu Kanban splits that one session in two: a small one that plans, and a
fresh one per card that does the work.

```
One long session                       With the board

┌───────────────────────────┐          ┌────────────────┐
│ the plan                  │          │ the plan       │  your session:
│ task 1  files, logs, diff │          │ card results   │  stays small
│ task 2  files, logs, diff │          └───────┬────────┘
│ task 3  files, logs, diff │                  │ cards
│ task 4  ...               │          ┌───────┼────────┐
│ (compacted, plan fades)   │          ▼       ▼        ▼
└───────────────────────────┘        haiku   sonnet    opus
  every turn re-reads all of it      fresh   fresh     fresh
```

## The session you talk to stays small

You stay in one Claude Code session. When there is work to hand out, say
"create a kungfu todo for ..." and the `kungfu-todo` skill writes it up as cards
and drops them on the board (see [Importing cards](importing.md)).

From then on that session holds the plan, each card's status and the pull
request that comes back. The file reads, dead ends and test output happen in
the card's own session. Your session sees the result, and the diff when it
reviews the PR.

## Every card starts fresh

A card is one `claude -p` run. It starts with the card's prompt, the skills you
picked and any [contracts](contracts.md) it uses. It gets nothing from your
conversation.

That is why the skill insists on self-contained prompts: file paths,
constraints and decisions already made all go in the card. Ten cards are ten
small contexts, where one session would have been a single context that grew
ten times.

## Each card runs on the model it needs

Model and effort are set per card: haiku at low effort for docs and chores,
sonnet for routine code, opus or fable for the hard ones. In a single session
the whole backlog runs on whatever model that session happens to be on.

The skill tells the session writing the cards to route frugally. The Sensei
does the same if you turn it on (see [The Sensei](sensei.md)).

## Fixes resume, they don't restart

- A follow-up reopens the card's own session (`claude -r`), so the agent keeps
  what it already learned about the code. See
  [Follow-up prompts](board.md#follow-up-prompts).
- Red CI on a card's PR resumes that same session with the failing logs. No
  retry is spent. See [PR watch](pull-requests.md).
- Dependencies are declared with `after:`, and the board holds a card until the
  one it needs has merged. No agent run is spent finding out it was blocked.
  See [Dependencies](cards.md#dependencies).

## Smaller diffs by default

The board ships with [ponytail](https://github.com/DietrichGebert/ponytail)
(vendored, MIT) and selects it on new cards. It pushes agents toward the
smallest change that works: reuse before rewrite, the standard library before a
new dependency.

ponytail's own benchmarks put that at about 54% less code and 20% lower cost.
Those are its numbers, measured on its tasks. They were not measured on this
board.

## Nothing gets paid for twice

- The Sensei ships off. When a Claude Code session is driving the board, that
  session is the manager, and a second manager underneath it would pay again
  for the same review.
- The **parallel** cap keeps a batch from running into your rate limit all at
  once.
- A card that hits a usage limit is requeued and waits for the reset. It is not
  failed and re-run. See [Subscription limits](limits.md).

## Check it on your own board

- The **⛽ usage chip** shows output tokens used in the rolling 5-hour window,
  across the board and your terminal. Set a budget in ⚙ Settings and it becomes
  a percentage meter.
- A running card shows its live output tokens and how full its context is
  (ctx %).
- The card drawer keeps token and turn stats for every finished run.
- `npm run flow-report` and `npm run jev-report` print per-card numbers. See
  [Reports](reports.md).

## Where it does not help

There is no benchmark behind this page, only the mechanism.

Every card pays a startup cost. It loads its own system prompt and has to find
its way around the repo. For a two-line fix, that costs more than doing it in
the session you already have open.

The board earns its keep when the work is a list: several tasks that don't need
each other's context, or a job long enough that one session would compact
halfway through.

---

[Back to the docs index](README.md)
