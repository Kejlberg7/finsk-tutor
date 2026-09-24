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
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
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
      status text NOT NULL DEFAULT 'started'
    )
  `);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS live_session_id text`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS transcript jsonb`);
  await sqlClient.unsafe(`ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'started'`);
}
