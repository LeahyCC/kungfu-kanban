# Use it from your phone (Tailscale)

The server **refuses** to bind beyond loopback without an access token, because the
runner executes code. The safe path is a token + Tailscale (the port stays on
loopback; Tailscale proxies it inside your tailnet only):

```bash
# 1. one-time: create the token (this enables the login gate)
openssl rand -hex 16 > data/auth-token

# 2. run the board
npm start                          # logs: "token gate: ON"

# 3. one-time: serve it over your tailnet with HTTPS
tailscale serve --bg 4747
tailscale serve status             # shows your https://<machine>.<tailnet>.ts.net URL
```

On your phone: install Tailscale, sign in to the same tailnet, open the URL, enter
the token once — it's stored as a cookie for a year. Scripts/API calls can send
`Authorization: Bearer <token>` instead.

**Install it as an app**: the board is a PWA. On iPhone, open the tailnet URL in
Safari → Share → **Add to Home Screen** — you get a standalone full-screen app
with the robot icon and night-dojo status bar.

- Token can also come from the `KFK_TOKEN` env var (overrides the file).
- Rotate it by regenerating `data/auth-token` (old cookies stop working).
- `tailscale serve` is tailnet-only. **Never** use `tailscale funnel` or a public
  port-forward for this app.
- To stop sharing: `tailscale serve --https=443 off` (or `tailscale serve reset`).

---

[Back to the docs index](README.md)
