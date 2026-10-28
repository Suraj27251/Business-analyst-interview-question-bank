# Neon sync setup and operations

## Architecture and verified Vercel project

The static dashboard and Studio use one browser adapter in `state-sync.js`. It keeps the existing localStorage formats as an offline cache and backup, then calls same-origin Vercel Functions under `/api`. Server functions verify the signed session, allowlisted GitHub subject, store key, payload size, CSRF token, and expected revision before issuing parameterized SQL. Neon credentials never enter browser code.

The existing Vercel project `business-analyst-prep-dashboard` is linked in the local `.vercel` directory, which is ignored by Git. The Vercel CLI login was verified for the existing account. Production and Preview currently expose these Neon integration variable names (values were not displayed): `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_PRISMA_URL`, `PGHOST`, `PGHOST_UNPOOLED`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and related Neon metadata. Development currently has no variables. The runtime uses the pooled `DATABASE_URL`; use an unpooled URL only for a separately controlled migration connection. No production environment values were downloaded or changed.

## State inventory

All identified stores are user state and are allowlisted: `baDays`, `baTaskChecks`, `baNote1` through `baNote15`, `baPracticedQuestions`, `baQuestionRatings`, `baSavedQuestions`, `baQuestionAnswers`, `baRecent`, `baSources`, `baMockSession`, `baMockHistory`, `baFocusSession`, `baFocusLog`, `baStudioRecent`, `baStudioCaseResponses`, `baStudioJdText`, `baStudioJdChecklist`, `baStudioJdResult`, `baStudioJdConfidence`, `baStudioJdNotes`, `baStudioMockSession`, and `baStudioMockHistory`.

Dashboard and Studio share practiced questions, ratings, saved questions, and answers. `baSources` records the user's per-source practice toggles and is synchronized as personal state. Notes remain plain strings; ratings accept legacy string values and current objects; saved-question records keep their current maps and metadata. Mock sessions, answers, job-description text, and notes may contain personal content. Focus session records preserve their existing end timestamp and remaining duration; the active timer itself continues to tick only in the browser. The question corpus, source text, extracted indexes, generated data, and search results are static/derived content and are excluded.

## Database schema and migrations

Apply `migrations/001_initial_state.sql` once to the existing Neon database with an unpooled migration connection after reviewing the SQL, for example `psql "$env:DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f migrations/001_initial_state.sql` in PowerShell after setting that variable locally. It creates `app_users`, `user_state`, and `migration_receipts` transactionally and does not reset or delete data. Runtime SQL is parameterized and scopes every read/write to the authenticated app user. Initial state imports use insert-only semantics; regular saves require the last-seen revision and return a conflict on stale revisions.

The application has not run this migration against Neon. No database tables were inspected or changed. After a future schema change, add a numbered migration and document any data-preserving rollback. An application rollback leaves imported rows in place; do not drop tables or clear localStorage.

## Authentication configuration

Authentication uses a GitHub OAuth App and a server-side seven-day signed, HttpOnly session. The callback verifies OAuth `state`, PKCE (`S256`), exchanges the code on the server, reads the immutable numeric `id` from GitHub's `/user` API, and rejects identities outside `GITHUB_ALLOWED_SUBJECT`. Email is not used. Mutations require both same-origin `Origin` and the session CSRF token.

To obtain the subject for the GitHub account you intend to authorize, run `gh api user --jq .id` while GitHub CLI is authenticated as that account, then use that numeric result for `GITHUB_ALLOWED_SUBJECT`.

Create or select a GitHub OAuth App and configure its callback URL as `https://YOUR_HOST/api/auth/callback`. `APP_URL` must be the exact canonical origin that serves each environment; use a stable Preview domain and a separate OAuth App if the callback URLs differ. For local development, use a local OAuth App configured with `http://localhost:3000/api/auth/callback`. Set these server-only variables in Vercel Preview and Production:

- `DATABASE_URL`: pooled Neon URL already present in the existing Preview and Production project environments.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: OAuth App credentials.
- `GITHUB_ALLOWED_SUBJECT`: the owner's verified numeric GitHub user ID, not a username or email.
- `SESSION_SECRET`: at least 32 random bytes, independently generated for each environment.
- `APP_URL`: the canonical origin, without a trailing slash.

These authentication variables are not currently configured in Vercel. No live settings were changed. Keep Preview on an isolated Neon branch if it must not share Production data. Before enabling Production, verify that `DATABASE_URL` uses a server-only runtime role restricted to the three application tables and required `SELECT`, `INSERT`, and `UPDATE` operations; the role grants were not inspected. `.env.example` contains placeholders only. For local work, make a private `.env.local` with a development database branch and local OAuth callback `http://localhost:3000/api/auth/callback`, then set `APP_URL=http://localhost:3000`. Never commit `.env.local`.

## Local development and Vercel CLI

The local directory is linked to the existing Vercel project. The installed CLI is Vercel CLI 64.2.0. Use `npm install`, `npm exec -- vercel dev`, and `npm test`. Local development needs `.env.local`; Vercel Development currently has no variables, so `vercel env pull` cannot supply local authentication/database configuration yet. The existing database variables are marked Sensitive, so Vercel CLI did not provide their values to a local child process; the Preview `SELECT 1` check could not run. Do not run `vercel deploy --prod` as part of setup.

For Preview and Production, add the required OAuth/session variables through the Vercel project settings after the provider and owner subject are verified. Existing Neon variables are already configured for Preview and Production. Use `vercel env ls <environment> --format json` only when you need to inspect configuration; treat all variable values as secrets.

Apply the SQL migration manually to the intended database, then test locally with a dedicated development database. Preview and Production each need their own reviewed migration target. Do not point Preview tests at production data.

## First-login import, backup, and conflicts

On sign-in, the adapter reads cloud state before syncing. If local progress is present, the sync control offers an explicit **Import local progress** action and downloads a JSON backup as the import starts. The import ID is unique and retry-safe, and the endpoint never replaces an existing cloud record. Existing local values remain in localStorage.

When the same store differs between the browser and server, the UI stops automatic writes and offers a backup plus explicit choices to keep the server copy or this device's copy. The server-copy choice updates the local cache. The device-copy choice writes against the latest known revision; another concurrent change produces another conflict. Arrays are never merged automatically. Download progress any time with **Export backup**.

Offline edits remain in localStorage and show Offline/Sync failed until the user retries. A successful status appears only after the server confirms a write. Dashboard and Studio use the same adapter, including their four shared question stores.

## Tests and checks

`npm test` runs the built-in Node tests for the complete key inventory, legacy rating/saved-question formats, dynamic note strings, size/type checks, signed session expiry/tampering, and CSRF validation. Live authorization/API/database integration tests require the configured OAuth identity and a dedicated test database; they have not been run against Production.

## Rollback

To roll back the application, restore the previous static deployment or revert this feature branch and redeploy the prior code. Existing localStorage remains untouched. Keep Neon tables and rows; do not truncate/drop them or automatically re-import stale browser data. Users can export their local progress before any later cleanup.
