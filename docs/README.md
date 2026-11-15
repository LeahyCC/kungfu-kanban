# Kungfu Kanban docs

The [project README](../README.md) is the short version. Everything technical
lives here, one topic per file.

## Start here

| Doc | What is in it |
| --- | --- |
| [How the board saves tokens](token-savings.md) | Why cards cost less than one long session, and where they don't |
| [Architecture](architecture.md) | The server, the CLI, worktrees and PRs in one diagram |

## Using the board

| Doc | What is in it |
| --- | --- |
| [The board](board.md) | Columns, the card drawer, the built-in terminal, archiving, follow-up prompts |
| [Cards](cards.md) | Card fields, skills and agents, dependencies, scheduled cards, what every prompt gets |
| [Importing cards](importing.md) | The Markdown format, the watch folder, GitHub issues, the `kungfu-todo` skill |
| [Repo cards and PRs](pull-requests.md) | Worktrees, how a PR gets opened, PR watch and the auto-fixers |
| [Contracts](contracts.md) | Files one card publishes for other cards to build against |
| [The Sensei](sensei.md) | The optional LLM manager: autonomy, triggers, guardrails |
| [Subscription limits](limits.md) | Cooldown on a usage limit, model fallback |
| [Notifications](notifications.md) | macOS, phone pushes through ntfy, the error tracker |
| [Reports](reports.md) | `npm run flow-report`, `npm run jev-report` and shadow model routing |

## Setup and reference

| Doc | What is in it |
| --- | --- |
| [Phone access](phone.md) | The token gate, Tailscale, installing the board as an app |
| [Run at login](run-at-login.md) | The launchd agent for macOS, the supervisor for Windows |
| [Configuration](configuration.md) | Environment variables and the files in `data/` |
| [Troubleshooting](troubleshooting.md) | Common failures and how to fix them |
| [Security notes](security-notes.md) | What the board can run, and how it is locked down |

To report a vulnerability, see [SECURITY.md](../SECURITY.md). To contribute, see
[CONTRIBUTING.md](../CONTRIBUTING.md).
