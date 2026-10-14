import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let database: PostgresJsDatabase<typeof schema> | null = null;
let sqlClient: ReturnType<typeof postgres> | null = null;
let schemaPromise: Promise<void> | null = null;

export function isDatabaseConfigured(): boolean {
  return Boolean(databaseUrl());
}

export function getDatabase(): PostgresJsDatabase<typeof schema> {
  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL mangler.");

  if (!database) {
    sqlClient = postgres(url, { prepare: false, max: 1 });
    database = drizzle(sqlClient, { schema });
  }

  return database;
}

function databaseUrl(): string | undefined {
  return process.env.NEON_DATABASE_DATABASE_URL?.trim()
    || process.env.NEON_DATABASE_URL?.trim()
    || process.env.DATABASE_URL?.trim();
}

export function ensureDatabaseSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = createSchema().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function createSchema(): Promise<void> {
  getDatabase();
  if (!sqlClient) throw new Error("Databaseforbindelsen kunne ikke oprettes.");

  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS learner_profile (
      id integer PRIMARY KEY DEFAULT 1,
      level text NOT NULL DEFAULT 'Ny begynder',
      current_focus text NOT NULL DEFAULT 'Korte hverdagssætninger og tydelig udtale',
      next_lesson text NOT NULL DEFAULT 'Hilsner og at præsentere sig selv',
      upcoming_lessons jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sqlClient.unsafe(`ALTER TABLE learner_profile ADD COLUMN IF NOT EXISTS upcoming_lessons jsonb`);
  await sqlClient.unsafe(`ALTER TABLE learner_profile ADD COLUMN IF NOT EXISTS next_targets jsonb`);
  await sqlClient.unsafe(`ALTER TABLE learner_profile ADD COLUMN IF NOT EXISTS review_only_next_session integer NOT NULL DEFAULT 0`);
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS vocabulary (
      id serial PRIMARY KEY,
      finnish text NOT NULL,
      english text NOT NULL,
      danish text,
      example text,
      mastery integer NOT NULL DEFAULT 0,
      correct_count integer NOT NULL DEFAULT 0,
      incorrect_count integer NOT NULL DEFAULT 0,
      last_seen_at timestamptz,
      next_review_at timestamptz
    )
  `);
  await sqlClient.unsafe(`ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS correct_count integer NOT NULL DEFAULT 0`);
  await sqlClient.unsafe(`ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS incorrect_count integer NOT NULL DEFAULT 0`);
  await sqlClient.unsafe(`ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS correct_day_count integer NOT NULL DEFAULT 0`);
  await sqlClient.unsafe(`ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS last_correct_day text`);
  await sqlClient.unsafe(`ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS last_feedback text`);
  await sqlClient.unsafe(`ALTER TABLE vocabulary ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`);
  await sqlClient.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS vocabulary_finnish_unique ON vocabulary (finnish)`);
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS grammar_skills (
      id serial PRIMARY KEY,
      key text NOT NULL,
      name text NOT NULL,
      mastery integer NOT NULL DEFAULT 0,
      correct_count integer NOT NULL DEFAULT 0,
      incorrect_count integer NOT NULL DEFAULT 0,
      last_seen_at timestamptz,
      next_review_at timestamptz
    )
  `);
  await sqlClient.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS grammar_skills_key_unique ON grammar_skills (key)`);
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS practice_sessions (
      id serial PRIMARY KEY,
      live_session_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      transcript jsonb,
      summary text,
      status text NOT NULL DEFAULT 'started',
      progress_cursor integer NOT NULL DEFAULT 0,
      voice_seconds integer NOT NULL DEFAULT 0
    )
  `);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS live_session_id text`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS transcript jsonb`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS recap jsonb`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'started'`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS progress_cursor integer NOT NULL DEFAULT 0`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS voice_seconds integer NOT NULL DEFAULT 0`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS close_reason text`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS close_confirmed integer NOT NULL DEFAULT 0`);
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS session_diagnostics (
      id text PRIMARY KEY,
      attempt_id text NOT NULL,
      session_id integer,
      event_type text NOT NULL,
      code text,
      message text,
      details jsonb,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sqlClient.unsafe(`CREATE INDEX IF NOT EXISTS session_diagnostics_created_idx ON session_diagnostics (created_at DESC)`);
  await sqlClient.unsafe(`CREATE INDEX IF NOT EXISTS session_diagnostics_session_idx ON session_diagnostics (session_id, occurred_at DESC)`);
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS api_usage_events (
      id serial PRIMARY KEY,
      session_id integer NOT NULL,
      response_id text NOT NULL,
      model text NOT NULL,
      input_tokens integer NOT NULL,
      cached_input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL,
      estimated_cost_usd numeric(16, 10) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sqlClient.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS api_usage_events_response_unique ON api_usage_events (response_id)`);
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS idea_notes (
      id serial PRIMARY KEY,
      session_id integer,
      source_key text NOT NULL,
      kind text NOT NULL,
      content text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sqlClient.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idea_notes_source_key_unique ON idea_notes (source_key)`);
}
