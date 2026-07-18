# Kungfu Kanban — UI/UX Review

Date: 2026-07-17 · Scope: `public/` (the app), `lib/auth.js` (login page), `site/` (marketing site, light pass), plus server endpoints where they shape UX. No code changes made.

The design system ("Ink & Tape") is genuinely strong: consistent tokens, dark-first theming with a pre-paint script (no flash), `:focus-visible` styles, `prefers-reduced-motion` handling, hard-shadow print aesthetic carried through modals, drawer, and login page. The issues below are mostly about **interaction robustness, accessibility, and mobile** — not visual design.

Severity: 🔴 high · 🟡 medium · ⚪ low/polish

---

## 1. Accessibility

### 🔴 1.1 Cards and skill chips are mouse-only
- Cards are `<div>`s with a click handler (`app.js:113`) — no `tabindex`, no `role="button"`, no Enter/Space handling. Keyboard users cannot open a card at all.
- Skill chips in the card editor are `<span>`s with click handlers (`app.js:224-241`) — unreachable and untoggleable by keyboard.
- The only ARIA in the entire front end is `role="status"` on the antenna (`index.html:29`). There is no `role="dialog"` / `aria-modal` / `aria-labelledby` on any of the three modals or the drawer (`index.html:127, 188, 239, 280`).

### 🔴 1.2 No Escape key, no focus trap, no focus return
- No `keydown` handler exists anywhere in `public/` (verified by grep). Modals and the drawer can only be closed by mouse (✕ button, Cancel, or backdrop click).
- When a modal opens, focus goes to the first field (`app.js:243`) but Tab can escape behind the backdrop; when it closes, focus is not returned to the triggering button.

### 🟡 1.3 Quick actions are invisible until hover
`.card-run` buttons are `opacity: 0` until `.card:hover` / `:focus-within` (`style.css:562-602`). Keyboard focus *is* handled via `:focus-within`, and touch devices get always-visible buttons via `@media (hover: none)` — but a sighted mouse user has no idea ▶/✓/✕ exist until they happen to hover a card. Core actions (run, approve) are undiscoverable.

### 🟡 1.4 Touch targets below guidance
- Quick-run buttons: 24 × 24 px (`style.css:563-565`)
- Theme toggle: 30 × 30 px (`style.css:417`)
- `.mini` / drawer / suggestion buttons: ~26-30 px tall (`style.css:918, 1023`)
WCAG 2.5.8 / Apple HIG suggest ≥ 24 px *minimum* (44 px comfortable). On a phone these are cramped, and they are the primary actions.

### 🟡 1.5 Information encoded without text alternatives
- The priority square is an empty `<span class="prio-high">` whose only explanation is `title="P2"` (`app.js:116`) — screen readers get nothing, and P0 vs P1 are visually indistinguishable (sort order only).
- Belt colors distinguish columns, but column headers do carry names — this one is fine; flagged only because the header status chips rely on dot color + tooltip alone.

### ⚪ 1.6 Tabs aren't tabs
Board / Manager are plain buttons (`index.html:31-34`) — no `role="tablist"`, no `aria-current`/`aria-selected`, no arrow-key navigation.

### ⚪ 1.7 Very small text
Badges at 10.5 px (`style.css:270`), usage-stat labels at 10 px (`style.css:739`), runword/failword at 10.5 px — below comfortable reading size, and the placeholders/labels use the low-contrast `--ink-400`.

### ⚪ 1.8 App has no skip link
The marketing site has one (`site/index.html:26`); the app doesn't.

---

## 2. Mobile & responsive

### 🔴 2.1 No touch alternative for drag-and-drop
HTML5 drag-and-drop (`app.js:65-80, 112`) does not work on touchscreens. Quick actions cover run / unqueue / approve / delete, but on a phone there is **no way to move a card to an arbitrary column** (e.g. Backlog → Review, Done → Backlog) or reorder. The board is only fully operable with a mouse.

### 🟡 2.2 The board never goes single-column
At every viewport the board stays 5 columns of ≥ 220 px with horizontal scrolling (`style.css:483, 1082-1086`). On a phone that's ~1100 px of sideways scrolling to see Done. The Manager view stacks at 980 px (`style.css:829`) — the board has no equivalent.

### 🟡 2.3 Essential explanations live only in tooltips
Nearly all teaching copy is in `title` attributes: the usage chip (`index.html:36`), cooldown chips (37-38), the concurrency control (50), every Manager setting (66-104), the permissions safety explanation (`index.html:150` — arguably the most dangerous choice in the app), worktree/PR checkboxes (168-169). Tooltips don't exist on touch and are easy to miss on desktop. There is no inline help text or info-popover alternative.

### 🟡 2.4 Board summary disappears on small screens
All four status chips are hidden below 900 px (`style.css:1084`). On a tablet/phone you lose the only aggregate counts. The wordmark also vanishes below 560 px (`style.css:1089`) — reasonable, but combined with hidden chips the header carries little state.

### ⚪ 2.5 `100vh` math on iOS
Column max-height uses `calc(100vh - 150px)` (`style.css:498`); mobile Safari's dynamic chrome makes this jump/clip. `dvh` units or a fallback would be safer.

---

## 3. Interaction & state bugs

### 🔴 3.1 SSE events wipe unsaved Manager-settings edits
`renderManager()` rewrites every `#mgrForm` field from server state (`app.js:882-896`), and `loadManager()` is called on **every** manager SSE event while the tab is visible (`app.js:1031-1041`) and after every chat send (`app.js:1016`). If you're mid-edit on the autonomy ladder or style prompt and the Sensei does anything, your unsaved changes are silently overwritten.

### 🔴 3.2 Streaming output yanks scroll to bottom
Every output chunk does `box.scrollTop = box.scrollHeight` (`app.js:1056-1060`). If you scrolled up in a long transcript to read, the next chunk teleports you to the bottom. Same pattern in the Manager chat (`app.js:909`). Standard fix: only auto-scroll if already within N px of the bottom.

### 🔴 3.3 Error messages render in green
`.import-result` is hard-coded `color: var(--success)` (`style.css:754-760`), yet it's the channel for *all* import feedback — `✕ draft failed`, `✕ cancelled`, `✕ copy blocked by browser` (`app.js:405, 432-433, 447, 467-469`). Failures look like successes.

### 🔴 3.4 Silent failures everywhere
- `api()` (`app.js:18-26`) has no error path: a non-JSON 500 response throws; rejected fetches are unhandled. Most mutations ignore `r.error` — quick run/unqueue/approve (`app.js:159-161`), drawer model/effort selects (`app.js:682`), prompt save (`app.js:644`, partially handled), concurrency change (`app.js:1064-1066`).
- Initial load (`app.js:1210-1218`): if `/api/config` or `/api/tasks` fails, the page just stays blank. There is no error state, retry, or even a spinner — indistinguishable from "server is starting" and from an empty board.
- EventSource (`app.js:1020`) has no `onerror` handler — if SSE drops, the board silently goes stale with no "disconnected" indicator.

### 🟡 3.5 Backdrop click discards a full card draft without asking
Clicking the backdrop or Cancel closes the card modal immediately (`app.js:283-286`) — a long prompt, acceptance criteria, and skill picks are gone with no dirty-check. Same for the import modal (which at least aborts in-flight work, `app.js:330-338`). The drawer ✕ similarly discards an unsaved prompt edit with no warning.

### 🟡 3.6 Full board re-render on every SSE task event
`render()` rebuilds all five columns from scratch on each task event (`app.js:1043-1046`): column scroll positions reset, in-progress drags die, hover states flicker. The SHIPPED-seal double-animation bug this caused had to be worked around with `stampedSeals` (`app.js:98-101`) — a symptom of the same rebuild-everything approach.

### 🟡 3.7 Drag highlight flicker
`dragleave` removes `.drag-over` whenever the pointer crosses into a child card (`app.js:66-67`), so the column outline strobes while dragging over a populated column. (Needs a `relatedTarget` containment check or a counter.)

### 🟡 3.8 Health line is checked once per page load, despite claiming otherwise
The tooltip says "Checked every few minutes" (`index.html:48`), and the server caches for 5 min (`server.js:256-269`) — but the client only calls `renderHealth()` at startup and after update actions (`app.js:1216, 1184, 1206`). A dead CLI shows a green ● until you reload. Conversely the toolbar line can go stale-good.

### 🟡 3.9 One-click approve, confirmed delete — inverted risk
The ✓ quick action on a Review card ships it to Done with **no confirmation** (`app.js:150, 161`), and drag-and-drop lets any card be dropped straight into Done (or Review) with no run and no confirm (`app.js:68-79`). Meanwhile deleting a Done card gets a `confirm()`. The irreversible-ish, workflow-breaking actions are the unguarded ones.

### 🟡 3.10 No double-submit protection
Run, Approve/Reject suggestion, Send chat, Save card, Import — none disable while their request is in flight (`app.js:159-161, 257-280, 926-939, 1009-1017`). Double-clicking ▶ fires two runs. (The import modal's draft/refine/issues ops *do* handle this well via `importOp` — the pattern just isn't applied elsewhere.)

### 🟡 3.11 Manager chat accepts input while busy
`#mgrBusy` shows "thinking…" but the input stays enabled (`app.js:1009-1017`) — users can fire multiple overlapping Sensei runs (each a paid subscription call) with no queueing feedback.

### ⚪ 3.12 "Copied" resume badge becomes a wall of text
After copying, the badge text is set to `resume: cd "/long/path" && claude -r <id>` (`app.js:720`) — it ellipsizes into unreadability, and the tooltip still shows the old message.

### ⚪ 3.13 Native `confirm()` / `alert()` throughout
Delete, merge PR, close PR, clear chat, clear log, re-run, board update, CLI update (`app.js:163, 750, 760-767, 771, 999, 1004, 1178, 1201, 1205`) — unstyled, blocking, jarring against the design system, and `alert()` for merge failures gives no recovery path.

---

## 4. Information design & consistency

### 🟡 4.1 The "Backlog" header count isn't the Backlog count
`#countBacklog` shows backlog **+ queued** (`app.js:89`) but its chip tooltip says "Backlog" (`index.html:39`), while the board shows five distinct columns. The header summary can't be reconciled with what you see.

### 🟡 4.2 Settings that can't be cleared
`defaultCwd` and `reposDir` are only applied when truthy (`server.js:88, 101`) — once set, clearing the field and saving silently keeps the old value. `ntfyTopic` doesn't have this problem (105). The UI gives no hint the clear failed.

### 🟡 4.3 Terminology drift
"Manager" (tab, `index.html:33) = "The Sensei" (61-63); "Running" (column) = "training…" (`app.js:133`); "Done" (column) = "Shipped" (seal) = "Approve" (button); "Review" (column) = "verdicts" (81). Charming voice, but four names for one agent and two for one state adds real cognitive load for new users.

### 🟡 4.4 Safety-critical copy is hover-only
The Permissions field's explanation of `dontAsk/bypassPermissions: no guardrails` is a `title` attribute (`index.html:150`). The most dangerous setting in the app is documented only in a tooltip (see 2.3).

### 🟡 4.5 No logout
Once authenticated, the cookie lives for a year (`lib/auth.js:67`) and there is no sign-out anywhere in the UI — awkward for the Tailscale/shared-machine scenario the token gate exists for.

### ⚪ 4.6 Context % assumes a 200k window
`Math.round(t.ctxTokens / 2000)` on both card and drawer (`app.js:135, 692`) — wrong for any model with a different context window.

### ⚪ 4.7 Timestamps
Activity log shows time only, no date (`app.js:954`) — ambiguous after midnight. Cards show no created/updated/age anywhere. Nothing uses relative time ("ran 2h ago").

### ⚪ 4.8 No board search / filter
Only priority sorting exists. With a few dozen cards there's no way to filter by repo, model, skill, label, or text.

### ⚪ 4.9 Theme polish
- No `prefers-color-scheme` respect: first visit is always night dojo regardless of OS setting (`index.html:18-21`).
- The app's theme toggle lacks `aria-pressed`; the marketing site's has it (`site/index.html:35-36`) — inconsistent implementations of the same control.
- `theme-color` is always `#141210` even in the light theme (`index.html:7`).

### ⚪ 4.10 PWA trappings without the P
A manifest and `apple-mobile-web-app-capable` are declared (`index.html:8-10`) but there's no service worker — "add to home screen" gets you an online-only bookmark.

### ⚪ 4.11 Long paths unreadable
The drawer cwd badge ellipsizes (`style.css:277-281`) with no tooltip to reveal the full path.

---

## 5. Login page (`lib/auth.js:34-55`)

Solid baseline: inline error, autofocus, `autocomplete="current-password"`, matches the theme. Gaps:

- ⚪ Always dark — ignores the saved `kk-theme` the rest of the app honors.
- ⚪ No rate-limit feedback; wrong-token attempts just repaint (server-side concern with a UI surface).
- ⚪ Tells you the token lives in `data/auth-token` but offers no copyable command — a tiny `<code>` block of `openssl rand -hex 16 > data/auth-token` would save a docs trip.

## 6. Marketing site (`site/`) — light pass

- Better a11y than the app (skip link, `aria-pressed`, aria-hidden decorative numerals) — the app should catch up, not the reverse.
- The "live board replica" (`site/index.html:113+`) hand-duplicates the app's board markup/classes — it will drift out of sync with the real product as the app evolves.
- Shares `kk-theme` with the app — good — but a light-theme visitor of the app still hits a dark login page and dark `theme-color` (4.9).

---

## Suggested priority order

| # | Fix | Why first |
|---|-----|-----------|
| 1 | 3.4 loading/error states + api() error handling | Blank page & silent failures undermine everything |
| 2 | 3.1 Manager form clobber | Data loss of user input |
| 3 | 3.2 Conditional auto-scroll | Daily-driver annoyance |
| 4 | 1.1 + 1.2 keyboard & dialog semantics | Core a11y: Escape, focus trap, operable cards |
| 5 | 3.3 error color in import | One-line CSS/class fix, currently misleading |
| 6 | 3.9 guardrails on approve/drag-to-Done | Prevents accidental ships |
| 7 | 2.1/2.2 mobile card moves + single-column layout | Makes the phone experience real |
| 8 | 4.1 header count label | One-word fix for a trust issue |
| 9 | 4.2 clearable settings | Small server+UI fix |
| 10 | 2.3 tooltip-dependent docs → inline help | Unblocks touch users and safety copy (4.4) |
