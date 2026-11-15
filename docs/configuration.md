# Configuration reference

**Environment variables**

| Var                | Default     | Meaning                                                             |
| ------------------ | ----------- | ------------------------------------------------------------------- |
| `PORT`             | `4747`      | listen port                                                         |
| `HOST`             | `127.0.0.1` | bind address; anything non-loopback requires a token                |
| `KFK_TOKEN`        | —           | access token (overrides `data/auth-token`)                          |
| `KFK_SHELL`        | `$SHELL`    | shell the built-in terminal launches                                |
| `KFK_PYTHON`       | `python3`   | interpreter for the terminal's pty helper                           |
| `KFK_TYPESAFE_KEY` | —           | turns on [shadow model routing](reports.md#shadow-model-routing-optional-jev) |

**Files (`data/`, gitignored — this is all app state)**

| File                          | Contents                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.json`                  | all cards                                                                                                                                                                                               |
| `settings.json`               | parallel cap, default cwd, ntfy topic, notification toggle, archive-after-days, manager config, `maxRunMinutes` (per-run watchdog, default 120, 0 disables), `terminal` (built-in terminal, default on) |
| `manager.json`                | pending suggestions, chat history, launch timestamps                                                                                                                                                    |
| `manager-log.jsonl`           | manager activity log                                                                                                                                                                                    |
| `errors.json`                 | error tracker entries (see [Error tracker](notifications.md#error-tracker))                                                                                                                                             |
| `transcripts/<task-id>.jsonl` | per-card transcript                                                                                                                                                                                     |
| `archive.jsonl`               | Done cards swept out after `archiveDays` (append-only)                                                                                                                                                  |
| `inbox/`                      | watch folder for markdown imports; imported files move to `inbox/imported/`                                                                                                                             |
| `auth-token`                  | access token (create to enable the gate)                                                                                                                                                                |

Back up `data/` to keep your board; delete it to factory-reset. Individual sessions
can always be reopened in the terminal with `claude -r <session-id>` (shown in each
card's drawer).

---

[Back to the docs index](README.md)
