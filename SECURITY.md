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
- There is no CI and no automation that runs code from external pull requests;
  the PR auto-fix flow only ever operates on branches this board created.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability") rather than a public issue. You'll
get a reply as time permits and credit in the fix commit if you want it. No
bounty program — this is a personal project.
