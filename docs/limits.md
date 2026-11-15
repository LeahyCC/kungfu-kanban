# Subscription limits, automatic cooldown

When a run dies on a usage/rate limit, the board:

- parses the reset time from the CLI's error (falls back to a 1-hour backoff),
- **requeues the card** (it wasn't a real failure) and pauses all auto flow —
  queue pumping, Sensei triggers, PR auto-fix — until the limit resets,
- shows a **⏳ countdown chip** in the header, and pings your phone.

Manual run clicks during cooldown queue instead of burning against the wall.
When the timer expires everything queued launches automatically and you get a
"training resumes" notification.

**Model fallback**: a _model-specific_ cap or outage (e.g. an Opus-hours limit
while Sonnet still works, or a 529 overload) doesn't pause anything — the failed
model is blocked temporarily (30 min for caps, 10 for overloads), the card
requeues, and launches step down the ladder **fable → opus → sonnet → haiku**
until the block expires. Cards keep their configured model and climb back up
automatically; a **⬇ chip** in the header shows what's stepped down, and the
transcript notes every substitution. The Sensei's own runs substitute too.

---

[Back to the docs index](README.md)
