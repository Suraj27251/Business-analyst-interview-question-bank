-- BA Prep Desk cloud persistence - initial schema.
-- Applied by `npm run migrate` (db/migrate.mjs). Idempotent and version-tracked.

create extension if not exists pgcrypto;

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

-- A. Users and sessions -----------------------------------------------------

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_normalized text not null unique,
  password_hash text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists sessions_user_idx on sessions(user_id);
create index if not exists sessions_expires_idx on sessions(expires_at);

-- Lightweight, DB-backed rate limiting for auth endpoints so limits survive
-- across the ephemeral instances of Vercel Functions.
create table if not exists auth_rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  attempts integer not null default 0
);

-- B. Question progress ------------------------------------------------------

create table if not exists question_progress (
  user_id uuid not null references users(id) on delete cascade,
  question_id text not null,
  source_path text,
  source_index integer,
  practiced boolean not null default false,
  answer text,
  rating text,
  last_rated date,
  next_review_due date,
  review_interval_days integer,
  question_text text,
  source_name text,
  updated_at_ms bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id),
  constraint question_progress_rating_chk
    check (rating is null or rating in ('know', 'review', 'work'))
);
create index if not exists question_progress_due_idx
  on question_progress (user_id, next_review_due);

-- C. Saved questions --------------------------------------------------------

create table if not exists saved_questions (
  user_id uuid not null references users(id) on delete cascade,
  question_id text not null,
  question_text text,
  source_path text,
  source_name text,
  source_index integer,
  saved_at timestamptz not null default now(),
  updated_at_ms bigint not null default 0,
  primary key (user_id, question_id)
);

-- D. Roadmap progress -------------------------------------------------------

create table if not exists roadmap_days (
  user_id uuid not null references users(id) on delete cascade,
  day integer not null,
  completed boolean not null default false,
  note text,
  updated_at_ms bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table if not exists roadmap_tasks (
  user_id uuid not null references users(id) on delete cascade,
  day integer not null,
  task_id text not null,
  completed boolean not null default false,
  updated_at_ms bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day, task_id)
);

-- E. Source coverage --------------------------------------------------------

create table if not exists source_coverage (
  user_id uuid not null references users(id) on delete cascade,
  source_path text not null,
  reviewed boolean not null default false,
  updated_at_ms bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, source_path)
);

-- F. Mock interviews --------------------------------------------------------

create table if not exists mock_sessions (
  user_id uuid not null references users(id) on delete cascade,
  client_id text not null,
  started_at timestamptz,
  finished_at timestamptz,
  duration_minutes integer,
  answered integer,
  total integer,
  payload jsonb not null default '{}'::jsonb,
  updated_at_ms bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

-- G. Focus sessions ---------------------------------------------------------

create table if not exists focus_sessions (
  user_id uuid not null references users(id) on delete cascade,
  client_id text not null,
  session_date date,
  minutes integer,
  roadmap_day integer,
  completed boolean not null default false,
  ended_at timestamptz,
  updated_at_ms bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

-- H. User preferences -------------------------------------------------------

create table if not exists user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  recent jsonb not null default '[]'::jsonb,
  active_focus jsonb,
  active_mock jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
