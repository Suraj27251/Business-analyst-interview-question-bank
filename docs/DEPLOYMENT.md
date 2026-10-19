# Deployment checklist

Target: Vercel (static dashboard + `api/` functions) and Neon PostgreSQL from
the Vercel Marketplace. Cloud sync is optional: without `DATABASE_URL` the
dashboard still works and the API reports `cloudConfigured: false`.

> The steps marked **[verify]** require a real Neon database and browser. They
> were not executed in the development environment that produced this change.

## 1. Provision the database

- [ ] In the Vercel dashboard, open **Integrations / Marketplace** and add
      **Neon**.
- [ ] Create a database (or connect an existing Neon project) to the Vercel
      project. Use the **pooled** connection string for `DATABASE_URL`.
- [ ] Confirm the Vercel project has `DATABASE_URL` in **Settings → Environment
      Variables** for Production (and Preview if desired). Do not prefix it with
      `NEXT_PUBLIC_`/`VITE_`.
- [ ] Optional: set `SESSION_TTL_SECONDS` (default `2592000`).
- [ ] Leave `INSECURE_COOKIES` unset in production.

## 2. Apply the schema

Run once against the production database, from a trusted machine:

```powershell
$env:DATABASE_URL="postgresql://...-pooler.../db?sslmode=require"
npm install
npm run migrate -- --dry-run   # inspect planned statements
npm run migrate                # apply
```

- [ ] `schema_migrations` contains `001_init.sql`.
- [ ] Do not run migrations from API requests.

For local development with `vercel dev` over plain HTTP:

```powershell
$env:DATABASE_URL="postgresql://..."
$env:INSECURE_COOKIES="true"
vercel dev
```

## 3. Deploy

- [ ] Merge the feature branch and let Vercel build.
- [ ] `vercel.json` rewrites `/` to `/dashboard.html` and adds security headers.
- [ ] Confirm the deployment is served over HTTPS (Secure cookies).

## 4. Smoke tests **[verify]**

Use two browsers/profiles (or one normal + one private window).

### Anonymous / local-only

- [ ] Open the site without signing in. Complete a task, rate a question, save
      a question, add a note.
- [ ] Reload. Local progress persists. Status says *Sign in to sync progress*.

### First sign-up and migration

- [ ] Sign up with a new email/password (≥ 8 characters).
- [ ] Browser data is merged automatically; the modal closes and a toast reports
      imported records.
- [ ] Reload. Progress is intact.
- [ ] Query the database: rows exist in `users`, `question_progress`,
      `roadmap_days`/`roadmap_tasks`, `saved_questions` for that user id.

### Second device

- [ ] Sign in with the same account in another browser/profile.
- [ ] The cloud snapshot appears; the migration banner is shown only if that
      browser has its own local data.
- [ ] Change a rating on device A, reload device B, and confirm it updates.
- [ ] Edit the same record on both devices; the later timestamp wins and both
      converge after reload.

### Offline and retry

- [ ] Go offline in DevTools, make changes, confirm the pill shows *Offline*
      and the UI still updates.
- [ ] Reload while offline. Changes are still present.
- [ ] Go online. The pill returns to *All changes saved* and the other device
      receives the changes.

### Saved-question deletion

- [ ] Save a question, let the pill reach *All changes saved*.
- [ ] Remove it, then immediately reload before the debounce fires.
- [ ] The question stays removed (queued deletion is replayed before the cloud
      snapshot is fetched).

### Account controls

- [ ] **Export progress** downloads a JSON file containing the expected data.
- [ ] **Import browser data** merges the backup without creating duplicates.
- [ ] **Delete cloud progress** (with confirmation) clears cloud rows and the
      local cache. Another account is unaffected.
- [ ] **Sign out** clears the cached private data; signing in again reloads it.
- [ ] Unauthenticated `GET /api/progress` returns `401`.
- [ ] A POST without the `x-csrf-token` header returns `403`.

### Isolation

- [ ] Create a second account and confirm it cannot see the first account's
      progress.
- [ ] Attempt to include another `userId` in a request body; it is ignored.

## 5. Operations

- **Logs:** cross-check `[progress/import]`, `[auth/login]`, etc. in Vercel
  Function logs. Internal errors are logged without SQL or secrets.
- **Backups:** use Neon's branching/PITR. The app also provides per-user JSON
  export.
- **Limits:** request bodies are capped at 4 MB. Very large first imports can
  be rejected; prune unneeded mock-history payloads or raise the cap carefully
  (Vercel's hard limit is ~4.5 MB).
- **Session cleanup:** expired/revoked rows remain in `sessions`; they are
  ignored by queries. Optionally purge them on a schedule:
  `delete from sessions where expires_at < now() - interval '30 days';`

## 6. Rollback

The feature is additive and local-first.

- Fast disable: remove `DATABASE_URL` from the Vercel project and redeploy. The
  API returns `cloudConfigured: false`; the dashboard stays usable locally.
- Code rollback: redeploy the previous commit. Browser local data and Neon rows
  are untouched.
- Do **not** drop tables as part of a normal rollback; doing so destroys user
  progress. If you must, export first and confirm with the account owners.

## 7. Post-deploy checks

- [ ] No `.env` or connection string is present in git or client bundles.
- [ ] `npm test` passes.
- [ ] Response headers include `Cache-Control: no-store` for `/api/*`.
- [ ] HTTPS is enforced and cookies show `Secure; HttpOnly; SameSite=Lax`.
