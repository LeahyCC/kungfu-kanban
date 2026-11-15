# Contracts

A contract is a named, versioned text file one card publishes so other cards can
read it. The HTTP API stores and serves them, and a worktree card can publish a
file it wrote (see [Publishing from a card](#publishing-from-a-card)), and the
board has a [Contracts tab](#the-contracts-tab); dependencies on contracts come
later. Content is any text (the board never
parses it), up to 1 MB, with no NUL bytes. Files live in `data/contracts/<name>/<version>.<ext>`
and the metadata in `data/contracts/index.json`.

A contract's metadata is `{ name, version, sha256, taskId, publishedAt, ext, bytes }`.
`version` starts at 1 and goes up by one each time a name gets new content;
publishing the same content as the latest version changes nothing and returns
that version. `name` must match `^[a-z0-9][a-z0-9._-]{0,63}$` (no `..`, no trailing
`.`, no Windows device names like `con`), and `ext` (default `txt`) must match `^[a-z0-9]{1,10}$`.

| Request | Response |
|---|---|
| `POST /api/contracts` `{ name, content, ext?, taskId? }` | `{ contract, created }`; `created` is `false` when the content matched the latest version |
| `GET /api/contracts` | `{ contracts: [...] }`, the latest metadata per name, no content |
| `GET /api/contracts/:name` | `{ contract, content }` for the latest version |
| `GET /api/contracts/:name/:version` | `{ contract, content }` for that version |

Invalid input gets a `400` and an unknown name or version a `404`, both as `{ error }`.
Like the rest of `/api`, these routes sit behind the token gate.

## Publishing from a card

A worktree card declares the files it will write with a repeatable `publishes`
line in its card header:

```markdown
## Define the API shape
worktree: true
publishes: api-shape docs/api-shape.md
publishes: error-codes docs/errors.json
```

The task stores them as `publishes: [{ name, path }]`; the same shape is accepted
by `POST /api/tasks` and `PATCH /api/tasks/:id`. `name` follows the contract name
rule above. `path` is relative to the repo root: no absolute paths, no `..`
segment, no `:`. A bad line in an import is skipped and logged to the error
tracker as an import warning; a bad value over the API is a `400`.

The agent's prompt gets one line naming the file(s). When the card finishes
cleanly (no error, not stopped), the board reads each path from the card's
worktree and publishes it as that contract, with `taskId` set to the card and the
file's extension as `ext` (`txt` if it has none or an invalid one). A path that
resolves outside the worktree, including through a symlink, is refused. A missing
file or a rejected one (binary, over 1 MB) never fails the card: it becomes a note
in the card's transcript and an error-tracker entry of kind `publish`.

Each new version is recorded on the card as `task.published`, a list of
`{ name, version, sha256, publishedAt }`. Publishing content identical to the
latest version records nothing.

`POST /api/tasks/:id/publish` does the same on demand for a card in review or
done whose worktree still exists, and returns `{ published, unchanged, problems }`.
It answers `404` when the worktree is gone, `409` when the card is not in review
or done, and `400` when the card is not a worktree card or declares no `publishes`.

## Waiting on a contract

A card can wait for a contract instead of a card, with a repeatable `uses` line:

```markdown
## Build the client
uses: api-shape          # any version
uses: error-codes@2      # exactly version 2
```

The task stores them as `uses: [{ name, version }]`, with `version` null when
not pinned. `POST /api/tasks` and `PATCH /api/tasks/:id` accept the same list,
or strings like `"api-shape@2"`; a bad entry is a `400`. A bad import line is
skipped with an import warning, like a bad `publishes` line.

A queued card launches once every `after:` prerequisite is done **and** every
`uses` entry exists: any version of the name, or the pinned version. This is
weaker than `after:`: it means the contract was published, not that the
publishing card's code merged. Every new contract version (finish-time publish,
`POST /api/tasks/:id/publish`, `POST /api/contracts`) starts waiting cards right
away. Contracts are never deleted, so a met entry stays met. The card shows
`⛓ uses: <name>` while it waits, and its drawer says what it waits for.

When the card launches, each `uses` entry is resolved: unpinned means the latest
version at that moment, `@N` means exactly version N even if newer ones exist.
The agent's prompt then carries the full text of every contract, fenced, under a
header such as ``Contract `api` v1 (sha256 …), built against this exact version``.
The card records what it got as `contractsUsed: [{ name, version, sha256 }]` and
shows one `built against api v1` chip per entry (the sha is in its tooltip).
A re-run, or a follow-up that resumes the session, resolves again and records
again, so the field always describes the latest launch. If a contract cannot be
read at launch the card goes to Review with a `Failed to launch` error instead
of running without it.

## The Contracts tab

**Contracts** sits next to Archive in the header (palette command *Go to Contracts*,
hotkey `4`). It lists one row per contract name: the name, its latest version, the
first 8 characters of the sha, the publishing card's title (click it to open that
card's drawer; a card that has since been removed shows "(card removed)", and a
contract posted straight to the API shows "API") and when it was published.
Click a row to read the latest content in a read-only block, and use the version
picker to read an older one. Content is always shown as plain text, never parsed
as HTML or markdown.

A card that published something carries a badge on its tile for the newest
version of each contract (`api v2`), and its drawer lists every version it
published. Publishing sends the server's SSE frame `{ type: 'contracts' }` (also
sent when a version is posted to `POST /api/contracts`), so an open Contracts tab
refreshes on its own.

---

[Back to the docs index](README.md)
