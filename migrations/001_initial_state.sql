BEGIN;

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_provider text NOT NULL CHECK (auth_provider IN ('github')),
  provider_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS user_state (
  user_id uuid NOT NULL REFERENCES app_users(id),
  store_key text NOT NULL,
  data jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, store_key),
  CHECK (jsonb_typeof(data) IN ('object', 'array', 'string', 'number', 'boolean', 'null'))
);

CREATE TABLE IF NOT EXISTS migration_receipts (
  user_id uuid NOT NULL REFERENCES app_users(id),
  migration_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, migration_id)
);
CREATE INDEX IF NOT EXISTS user_state_updated_at_idx ON user_state (user_id, updated_at DESC);

COMMIT;
