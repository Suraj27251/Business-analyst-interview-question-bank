# BA Prep Desk

A self-contained interview-preparation dashboard for Business Analyst, SQL,
Power BI, Tableau, Agile and case-study material. The UI is a single static
page (`dashboard.html`) powered by `dashboard_data.js`; it runs with no build
step and can be hosted on any static host.

The dashboard stores progress in the browser first (offline-friendly). It can
also mirror that progress to an optional cloud account backed by Vercel
Functions and Neon PostgreSQL, so the same progress is available on every
device.

## Features

- 15-day roadmap with daily study tasks and notes
- Question practice with answers, ratings and spaced-review due dates
- Saved questions, mock interviews, Pomodoro-style focus sessions
- Full-text search across the extracted source material
- Local-first storage; cloud sync is optional and additive
- Email/password accounts with HttpOnly sessions and CSRF protection
- Per-user isolation and timestamp-guarded last-write-wins sync
- JSON export, local-data migration and a "delete cloud progress" control

## Local usage

Open `dashboard.html` directly, or serve the folder:

```powershell
npx --yes serve .
```

Everything works offline without an account. Without a configured database the
cloud controls report that sync is unavailable; local progress is unaffected.

To run the serverless API locally you need the Vercel CLI and a Neon database:

```powershell
npm install
vercel dev
```

See [docs/CLOUD_PERSISTENCE.md](docs/CLOUD_PERSISTENCE.md) for the cloud design
and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the deployment checklist.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests (Node's built-in test runner). DB integration tests are skipped unless `TEST_DATABASE_URL` is set. |
| `npm run migrate` | Apply `db/migrations/*.sql` to `DATABASE_URL`. Safe to re-run. |
| `npm run migrate -- --dry-run` | List pending migrations without applying them. |

## Configuration

Copy `.env.example` to `.env` for local development. Never commit `.env`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | For cloud sync | Neon PostgreSQL connection string (prefer the pooled `-pooler` host). |
| `TEST_DATABASE_URL` | No | Disposable database for integration tests. |
| `SESSION_TTL_SECONDS` | No | Session lifetime; defaults to 30 days. |
| `INSECURE_COOKIES` | No | Set to `true` only for plain-HTTP local testing. |

On Vercel, install the Neon integration from the Marketplace and connect it to
the project so `DATABASE_URL` is injected automatically.

## Project layout

```text
dashboard.html          Static UI (inline app logic)
dashboard_data.js       Pre-extracted source material and roadmap
cloud-sync.js           Local-first storage proxy + optional cloud sync UI
api/                    Vercel Functions (auth + progress endpoints)
lib/                    Validation, auth, HTTP helpers and data access
db/migrations/          Versioned PostgreSQL schema
db/migrate.mjs          Migration runner
tests/                  Unit and optional integration tests
docs/                   Cloud persistence design and deployment guide
```

## Privacy

Cloud sync is opt-in. Before sign-in, all progress stays in the browser. When
you sign out, the cached private copy is removed from that browser. Export your
cloud progress from the account panel if you want a portable backup.
