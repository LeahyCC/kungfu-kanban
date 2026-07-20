# Show HN draft (NOT POSTED — draft only, maintainer posts personally)

## Title

Show HN: Kungfu Kanban – a kanban board where the cards run themselves on Claude Code

## Body

I built a kanban board for one person: me. Every card is a task description; drop
it in Backlog and it runs itself as a Claude Code CLI session — no API keys, no
per-token billing. The runner strips `ANTHROPIC_API_KEY` from the environment
before spawning, so it can't silently fall back to pay-per-token if you happen to
have one set.

How it works: an Express server spawns `claude -p <prompt> --output-format
stream-json` per card and streams the output into that card's transcript over
SSE. Cards can declare dependencies on each other, so a multi-step piece of work
becomes a chain of cards that launch in order once their prerequisites are done.
An LLM "Manager" (itself a `claude -p` call) triages new cards, reviews finished
work, and can merge a PR once its checks are green — so a batch of cards can run
from backlog to merged without you touching each one.

It's local-first by design: everything lives as JSON files in a `data/` folder on
your own machine, there's no hosted version, and there won't be one. It runs on
your existing Claude subscription login, not API credits. One npm dependency
(Express). MIT licensed.

This started as a tool to manage my own backlog of side-project tasks — I got
tired of babysitting one Claude Code session at a time and wanted something that
could run several cards in parallel, respect dependencies between them, and hand
review/merge back to me only when it actually needed a human. It's rough around
the edges in places (real open issues, no polish theater), but it's been running
my actual work for a while now.

Repo: https://github.com/LeahyCC/kungfu-kanban
Site: https://kungfu-kanban.com

Happy to answer questions about the architecture, the Manager's autonomy model,
or why I stripped API key fallback specifically.

---

## r/ClaudeAI variant (shorter)

**Title:** Built a kanban board where cards run themselves via Claude Code CLI (local-first, subscription only, no API billing)

Every card on this board is a task prompt. Drag it to Queued and it runs as a
real `claude -p` session, streaming its transcript live. Cards can depend on
each other so a feature becomes a chain that launches itself in order, and an
LLM "Manager" (another Claude Code call) triages, reviews, and can merge PRs
once CI is green — so a batch of work can go from backlog to merged with
minimal babysitting.

Runs on your Claude subscription login (no API key, and it actively strips
`ANTHROPIC_API_KEY` from the environment so it can't quietly bill you per
token). Everything's local JSON files, one dependency (Express), MIT license,
no hosted version planned.

Repo: https://github.com/LeahyCC/kungfu-kanban

It's got real rough edges (labeled issues, not hidden) but it's been running my
own project work for a while now — figured others managing Claude Code tasks
solo might want it too.
