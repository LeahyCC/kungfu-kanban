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

Roadmap: OpenAI/Google adapters, repo-aware coding tasks (clone → agent → PR via Vercel
Sandbox), the LLM Manager from the local edition, Stripe billing after beta.

## Local edition (`local/`)

See [local/README.md](local/README.md). Runs task cards through the Claude Code CLI on your
subscription (no API key), with skills/agents discovery, git-worktree isolation, and an LLM
manager tab. `cd local && npm install && npm start` → http://localhost:4747.
