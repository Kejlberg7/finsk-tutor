import { integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const learnerProfile = pgTable("learner_profile", {
  id: integer("id").primaryKey().default(1),
  level: text("level").notNull().default("Ny begynder"),
  currentFocus: text("current_focus").notNull().default("Korte hverdagssætninger og tydelig udtale"),
  nextLesson: text("next_lesson").notNull().default("Hilsner og at præsentere sig selv"),
  upcomingLessons: jsonb("upcoming_lessons").$type<string[]>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vocabulary = pgTable(
  "vocabulary",
  {
    id: serial("id").primaryKey(),
    finnish: text("finnish").notNull(),
    english: text("english").notNull(),
    danish: text("danish"),
    example: text("example"),
    mastery: integer("mastery").notNull().default(0),
    correctCount: integer("correct_count").notNull().default(0),
    incorrectCount: integer("incorrect_count").notNull().default(0),
    lastFeedback: text("last_feedback"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("vocabulary_finnish_unique").on(table.finnish)],
);

export const grammarSkills = pgTable(
  "grammar_skills",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    mastery: integer("mastery").notNull().default(0),
    correctCount: integer("correct_count").notNull().default(0),
    incorrectCount: integer("incorrect_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("grammar_skills_key_unique").on(table.key)],
);

export const practiceSessions = pgTable("practice_sessions", {
  id: serial("id").primaryKey(),
  liveSessionId: text("live_session_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  transcript: jsonb("transcript"),
  summary: text("summary"),
  status: text("status").notNull().default("started"),
  progressCursor: integer("progress_cursor").notNull().default(0),
});

export const ideaNotes = pgTable("idea_notes", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id"),
  sourceKey: text("source_key").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("idea_notes_source_key_unique").on(table.sourceKey)]);
