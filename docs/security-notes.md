# Security notes

This board **executes code on your machine** with whatever permission mode a card
carries — `bypassPermissions` means exactly that. Accordingly:

- The server never binds beyond loopback without a token, and you shouldn't either.
  Tailscale serve (tailnet-only) + token is the supported remote path. No public
  exposure, ever.
- The manager's permission ceiling stops it from escalating cards beyond what you
  allow; deleting cards is hard-blocked regardless of autonomy.
- ntfy topics are public-by-obscurity: unguessable names only, no secrets in card
  titles.
- The token cookie is `HttpOnly`/`SameSite=Lax`, compared timing-safe, and lives a
  year; rotate `data/auth-token` to invalidate.
- The [built-in terminal](board.md#built-in-terminal-j) is a shell on the host, gated by the
  same token. It doesn't widen the blast radius (a card at `bypassPermissions`
  already runs anything), but it is the most direct path to one — switch it off in
  ⚙ Settings → System if you don't want it, and treat token loss as shell loss.

---

[Back to the docs index](README.md)
