// Version-controlled migration runner for Neon PostgreSQL.
//
// Usage:
//   DATABASE_URL="postgresql://..." npm run migrate
//   DATABASE_URL="..." npm run migrate -- --dry-run
//
// It applies every db/migrations/*.sql file (sorted) that has not yet been
// recorded in schema_migrations. Each migration is applied once and recorded
// with its filename, so re-running is safe and no-op on an up-to-date database.
//
// Migrations are intentionally *not* run from application requests: run this
// script (locally or from a controlled deployment step) after provisioning the
// database and whenever new migration files are added.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');
const dryRun = process.argv.includes('--dry-run');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ERROR: DATABASE_URL is not set. Set it to your Neon connection string.');
  process.exit(1);
}

const sql = neon(url);

// Split a SQL file into individual statements. Handles single quotes and
// dollar-quoted blocks; strip line comments first so a comment-only chunk is
// never sent as a statement.
function splitStatements(text) {
  const withoutComments = text
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const statements = [];
  let current = '';
  let inSingle = false;
  let dollar = null;
  for (let i = 0; i < withoutComments.length; i += 1) {
    const ch = withoutComments[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (withoutComments[i + 1] === "'") {
          current += withoutComments[i + 1];
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (dollar) {
      if (withoutComments.startsWith(dollar, i)) {
        current += dollar;
        i += dollar.length - 1;
        dollar = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(withoutComments.slice(i));
      if (match) {
        dollar = match[0];
        current += dollar;
        i += dollar.length - 1;
        continue;
      }
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function main() {
  await sql.unsafe(
    'create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())'
  );
  const appliedRows = await sql.unsafe('select version from schema_migrations');
  const applied = new Set(appliedRows.map((row) => row.version));

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip   ${file} (already applied)`);
      continue;
    }
    const text = readFileSync(join(migrationsDir, file), 'utf8');
    const statements = splitStatements(text);
    console.log(`${dryRun ? 'plan  ' : 'apply '} ${file} (${statements.length} statements)`);
    if (dryRun) continue;
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    await sql.query('insert into schema_migrations (version) values ($1) on conflict do nothing', [file]);
    appliedCount += 1;
  }

  console.log(
    dryRun
      ? 'Dry run complete. No changes were made.'
      : `Migrations complete. ${appliedCount} migration(s) applied.`
  );
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
