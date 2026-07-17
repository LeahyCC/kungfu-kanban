import { neon } from '@neondatabase/serverless';

export function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set — connect a Postgres (Neon) database to this project.');
  return neon(url);
}

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q = sql();
      await q`CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        title text NOT NULL,
        prompt text NOT NULL DEFAULT '',
        model text NOT NULL DEFAULT 'default',
        effort text NOT NULL DEFAULT 'default',
        priority int NOT NULL DEFAULT 0,
        acceptance_criteria text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'backlog',
        created_by text NOT NULL DEFAULT 'user',
        result_text text,
        error text,
        stats jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks (user_id, created_at DESC)`;
      await q`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repo_url text NOT NULL DEFAULT ''`;
      await q`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS base_branch text NOT NULL DEFAULT ''`;
      await q`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT 'user'`;
      await q`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS retries int NOT NULL DEFAULT 0`;
      await q`CREATE TABLE IF NOT EXISTS manager_config (
        user_id text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT true,
        model text NOT NULL DEFAULT 'opus',
        effort text NOT NULL DEFAULT 'medium',
        autonomy text NOT NULL DEFAULT 'suggest',
        style_prompt text NOT NULL DEFAULT '',
        on_finish boolean NOT NULL DEFAULT true,
        on_new_card boolean NOT NULL DEFAULT true,
        max_retries int NOT NULL DEFAULT 2,
        max_launches_per_hour int NOT NULL DEFAULT 10
      )`;
      await q`CREATE TABLE IF NOT EXISTS manager_suggestions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        action jsonb NOT NULL,
        trigger text NOT NULL DEFAULT '',
        guard text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS manager_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        kind text NOT NULL,
        text text NOT NULL,
        action jsonb,
        ts timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS manager_chat (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        role text NOT NULL,
        text text NOT NULL,
        ts timestamptz NOT NULL DEFAULT now()
      )`;
      await q`CREATE TABLE IF NOT EXISTS provider_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        provider text NOT NULL,
        encrypted_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, provider)
      )`;
    })();
    schemaReady.catch(() => { schemaReady = null; });
  }
  return schemaReady;
}
