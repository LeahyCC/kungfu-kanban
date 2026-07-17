# Kungfu Kanban

A kanban board where every card is an AI task. Two editions live in this repo:

| Edition | Where | Execution |
|---|---|---|
| **Web (SaaS)** | repo root — Next.js, deploys to Vercel | Hosted, **bring your own provider API key** (Anthropic first; usage bills to your provider account) |
| **Local** | [`local/`](local/) — Node/Express | Your local Claude Code CLI on your subscription login, plus an LLM Manager that triages/dispatches/reviews cards |

## Web edition (root)

Multi-tenant board: create task cards with per-card **model** (Fable / Opus / Sonnet / Haiku),
**effort** (low → max), **priority**, and **acceptance criteria**, then run them on your own
Anthropic API key. Results land in the Review column with token stats.

**Repo-aware coding tasks:** give a card a GitHub repo URL (plus a repo-scoped PAT in
Settings) and the run happens inside a Vercel Sandbox microVM — the repo is cloned, the
Claude Code CLI runs the task on your API key, changes are pushed as a `kungfu/<id>` branch,
and a pull request is opened automatically. The PR link appears on the card in Review.
Keep repo tasks small for now: the whole run must fit in the 5-minute function window.

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL + APP_ENCRYPTION_KEY
npm run dev
```

**Required setup on Vercel** (project → moonlightleads/kungfu-kanban):
1. **Neon Postgres** — Storage tab → add Neon; it injects `DATABASE_URL`. The schema
   auto-creates on first request.
2. **`APP_ENCRYPTION_KEY`** — `openssl rand -hex 32`, add as an env var. Provider keys are
   AES-256-GCM encrypted with it.
3. **Clerk** (optional, enables real accounts) — install the Clerk integration; auth turns on
   automatically once `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` exist.
   Without them the app runs as a single shared demo tenant (fine for beta testing).

**Manager tab:** an LLM manager (running on your API key, structured outputs) that triages
new cards, dispatches work, and reviews finished tasks against their acceptance criteria.
Autonomy ladder — `suggest` (every action needs your ✓, the default), `semi` (can
create/route/run), `auto` (full autopilot) — with guardrails: hourly launch cap, per-task
retry limit (rejected tasks re-run with the manager's feedback appended), and a freeform
management-style prompt. Triggers on new cards, on finished runs, and via chat.

Roadmap: OpenAI/Google adapters, long-running task runner (beyond the 5-min window),
Stripe billing after beta.

## Local edition (`local/`)

See [local/README.md](local/README.md). Runs task cards through the Claude Code CLI on your
subscription (no API key), with skills/agents discovery, git-worktree isolation, and an LLM
manager tab. `cd local && npm install && npm start` → http://localhost:4747.
