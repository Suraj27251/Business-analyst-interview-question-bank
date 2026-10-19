# Cloud persistence

This document describes the optional cloud sync layer added to the static
dashboard: what it stores, how conflicts are resolved, how data is protected,
and what is intentionally out of scope.

> Status: all code paths are unit-tested, but the live database flow has not
> been exercised against a provisioned Neon instance from this development
> environment. Follow [DEPLOYMENT.md](DEPLOYMENT.md) and verify the smoke tests
> there before relying on it.

## Design goals

1. **Local-first.** The dashboard keeps working offline and without an account.
   No existing UI code had to change: `cloud-sync.js` exposes a `localStorage`
   compatible proxy and the dashboard uses that proxy instead.
2. **No accidental data loss.** First sign-in offers a merge, never a silent
   replacement. Local data is backed up before migration. Cloud data newer than
   local data is kept.
3. **Per-user isolation.** The server derives the user id from a verified
   session cookie; it never accepts a user id from the request body.
4. **Cheap at rest.** Only progress is stored in Postgres. The ~8 MB of source
   material in `dashboard_data.js` remains static.
5. **No framework migration.** Small CommonJS functions under `api/`, plain
   SQL, two runtime dependencies.

## Architecture

```text
Browser
  dashboard.html ──uses──> window.PrepCloud.store (Proxy)
                                  │  immediate reads/writes
                                  ▼
                           localStorage cache
                                  │  record-level diff + debounce
                                  ▼
                     /api/*  (Vercel Functions, same origin)
                                  │  session cookie + CSRF header
                                  ▼
                     Neon PostgreSQL (serverless driver)
```

`cloud-sync.js` is loaded before `dashboard_data.js` and before the dashboard's
inline script. It provides:

- a synchronous `localStorage`-shaped Proxy so the existing UI is unchanged;
- per-record change detection with a persisted pending queue;
- debounced writes, bounded exponential backoff and an online/offline status
  pill;
- sign-in / sign-up / account modal, migration banner and toasts.

## Storage keys and mapping

The dashboard's existing keys are kept. Each key maps to one endpoint.

| Browser key | Shape | Endpoint |
| --- | --- | --- |
| `baPracticedQuestions` | `{ [questionId]: true }` | `/api/question-progress` |
| `baQuestionAnswers` | `{ [questionId]: string }` | `/api/question-progress` |
| `baQuestionRatings` | `{ [questionId]: { rating, lastRated, dueDate, intervalDays, question, sourceName, sourcePath } }` | `/api/question-progress` |
| `baSavedQuestions` | `{ [questionId]: { id, question, path, name, sourceIndex, savedAt } }` | `/api/saved-questions` |
| `baDays` | `{ [day]: boolean }` | `/api/roadmap` |
| `baTaskChecks` | `{ ["day:taskId"]: boolean }` | `/api/roadmap` |
| `baNote{day}` | raw string | `/api/roadmap` (`notes`) |
| `baSources` | `{ [sourcePath]: boolean }` | `/api/source-coverage` |
| `baMockHistory` | array, newest first | `/api/mock-interviews` |
| `baFocusLog` | array, newest first | `/api/focus-sessions` |
| `baMockSession` | object or `null` | `/api/preferences` (`activeMock`) |
| `baFocusSession` | object or `null` | `/api/preferences` (`activeFocus`) |
| `baRecent` | array of source paths | `/api/preferences` (`recent`) |

Question ids are `"<source path>::<source index>"`. Task ids are
`"<day>:<taskId>"` locally and are split into `day` + `taskId` on the wire.

Internal sync keys (not user data): `__prep_ts` (per-record timestamps),
`__prep_dirty` (pending keys), `__prep_removals` (pending deletes),
`__prep_owner`, `__prep_migrated`, `__prep_local_backup`, `__prep_last_sync`.

## Conflict resolution

Every record carries `updatedAt` in Unix milliseconds. The server applies
upserts with:

```sql
on conflict (...) do update ...
where excluded.updated_at_ms >= table.updated_at_ms
```

Consequences:

- Two devices editing the same record converge on the highest timestamp
  (last-write-wins). Ties are idempotent.
- A stale browser cannot overwrite newer cloud data during migration.
- When a browser record has no sync timestamp, migration falls back to a
  semantic timestamp where one exists (`lastRated`, `savedAt`, `finishedAt`,
  `endedAt`) and otherwise `0`. A `0` timestamp loses to any real cloud write.
- Partial records only update the columns they contain (`coalesce`), so a
  practice toggle cannot erase an answer or rating.

## First sign-in and migration

1. `/api/auth/me` establishes the session user and a CSRF cookie.
2. The client snapshots local progress, stores it under `__prep_local_backup`,
   and fetches the cloud snapshot.
3. **No cloud data:** local data is imported and becomes the account's data.
4. **Both local and cloud data:** the cloud snapshot is applied first. If this
   account has not migrated on this browser yet, a banner offers:
   - *Merge browser data* — timestamp-guarded import; newer cloud records win.
   - *Keep cloud only* — local data is left untouched in the backup.
5. **Pending local changes:** they are imported before the snapshot is applied
   so unsynced edits are not discarded.
6. Pending saved-question deletions are replayed before fetching the cloud
   snapshot so deleted questions are not resurrected.

The backup is never deleted automatically. The account panel can re-import it
with *Import browser data*.

## Offline and failure handling

- Reads and writes always hit the local cache first; the UI never waits for the
  network.
- Changes are queued per record with a timestamp and kept across reloads.
- Writes are debounced (250 ms–1.5 s per key) and retried with exponential
  backoff (1 s → 60 s, jittered) while online.
- The status pill reports `Saving…`, `All changes saved`, `Offline` or
  `Sync error`.
- `pagehide` sends pending writes with `keepalive` as a best effort.
- Permanent `4xx` validation errors stop retrying the bad batch and show a
  toast; the pending data is retained so it can be fixed or exported.
- An expired session (`401`) switches the UI to signed-out; local data remains
  available.

Focus timer ticks are deliberately ignored (only meaningful changes such as
starting, pausing, finishing or canceling are synced). Active mock and focus
sessions are uploaded, but are intentionally **not** restored into the UI on
another device.

## API

All authenticated endpoints are scoped to the session user.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auth/me` | none | Current user, cloud configuration, CSRF cookie |
| `POST` | `/api/auth/signup` | none | Create account + session |
| `POST` | `/api/auth/login` | none | Create session |
| `POST` | `/api/auth/logout` | none | Revoke session and clear cookies |
| `GET` | `/api/progress` | session | Full cloud snapshot |
| `POST` | `/api/progress/import` | session + CSRF | Merge or replace a snapshot |
| `GET` | `/api/progress/export` | session | Download JSON backup |
| `POST` | `/api/progress/delete` | session + CSRF | Delete all progress (keeps account) |
| `POST` | `/api/question-progress` | session + CSRF | Upsert practice/answers/ratings |
| `POST` | `/api/saved-questions` | session + CSRF | Upsert and delete saved questions |
| `POST` | `/api/roadmap` | session + CSRF | Upsert days, notes and tasks |
| `POST` | `/api/source-coverage` | session + CSRF | Upsert reviewed sources |
| `POST` | `/api/mock-interviews` | session + CSRF | Upsert mock interview history |
| `POST` | `/api/focus-sessions` | session + CSRF | Upsert focus history |
| `POST` | `/api/preferences` | session + CSRF | Recent sources and active session state |

Payload limits: 4 MB request body, 10,000 records per collection, 20,000
characters per answer/note. Validation rejects unknown types; SQL is always
parameterized.

## Security

- Passwords are hashed with bcrypt (cost 12). Login always performs a bcrypt
  comparison so a missing account does not leak through timing.
- Sessions are 256-bit random opaque tokens. Only their SHA-256 hash is stored
  in Postgres; the raw token lives in an `HttpOnly`, `SameSite=Lax`, `Secure`
  cookie (Secure is disabled only when `INSECURE_COOKIES=true` or on plain HTTP
  local dev).
- CSRF uses double-submit: a non-HttpOnly `prep_csrf` cookie must match the
  `x-csrf-token` header on state-changing requests. Same-origin is also checked.
- Auth endpoints are rate-limited in the database by IP (and by email for
  login), so limits survive serverless cold starts.
- Every SQL statement is scoped by the session user id. The client cannot
  choose whose data it reads or writes.
- Responses are `no-store`; the API never returns password hashes or tokens.
- Signing out or deleting cloud data clears the browser's cached private copy.

## Known limitations

- No email verification, password reset or account deletion UI.
- One account per browser session; there is no account switcher beyond sign-out.
- Active mock/focus sessions are not restored on another device.
- Removing an individual mock-history or focus-history entry is not synced as a
  deletion (the dashboard does not expose that action).
- Sync is per browser tab; concurrent tabs last-write-win at record level but do
  not live-push to each other.
- Request bodies over 4 MB are rejected; very large imports must be reduced
  (for example by exporting and pruning old mock-history payloads).

## Tests

```powershell
npm test
```

Covers validation/normalization, password and session helpers, SQL
parameterization and user scoping, timestamp guards, and snapshot mapping.

To run the real-database test (isolation, last-write-wins, idempotent import):

```powershell
$env:TEST_DATABASE_URL="postgresql://..."
npm run migrate
npm test
```

The integration test creates two unique `@example.invalid` users and deletes
only those rows.
