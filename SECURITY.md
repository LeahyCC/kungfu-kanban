# Security

Kungfu Kanban **executes code on the machine it runs on** — that is the product,
not a bug. The security model:

- The server binds `127.0.0.1` only, and refuses to bind wider without an
  access token (`data/auth-token` / `KFK_TOKEN`, timing-safe compared,
  HttpOnly cookie).
- Remote access is designed for tailnet-only exposure (`tailscale serve`);
  never expose the port publicly.
- All subprocesses use `execFile` with argument arrays (no shell
  interpolation); API-supplied repo paths are validated against a scanned
  allowlist before use.
- Agent output is HTML-escaped before markdown rendering.
- CI on an external pull request runs **only after a maintainer approves it**
  (GitHub holds fork-PR Actions until then), and even then it only runs
  `node --test` in GitHub's throwaway sandbox — it never touches a maintainer's
  machine, real `data/`, or any credential. The PR auto-fix flow only ever
  operates on branches this board created for itself, never on a contributor's.

## Contributing to security-sensitive code

Because the board executes code on the machine it runs on, a subtle change to
the wrong place is a real user-harm vector. If a pull request touches the
loopback bind or token gate, the `ANTHROPIC_API_KEY` deletion in the runner,
subprocess spawning (`execFile` arg arrays, no shell interpolation), repo-path
validation, or the client-side escaping / HTML-escape-before-markdown render,
**call it out in the PR description** so it gets the extra review it deserves.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability") rather than a public issue. You'll
get a reply as time permits and credit in the fix commit if you want it. No
bounty program — this is a personal project.
