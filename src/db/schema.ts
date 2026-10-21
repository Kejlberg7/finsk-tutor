import { integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { A1Assessment } from "@/lib/a1-test";
import type { HistoryState } from "@/lib/practice-history";

export const learnerProfile = pgTable("learner_profile", {
  id: integer("id").primaryKey().default(1),
  level: text("level").notNull().default("Ny begynder"),
  currentFocus: text("current_focus").notNull().default("Korte hverdagssætninger og tydelig udtale"),
  nextLesson: text("next_lesson").notNull().default("Hilsner og at præsentere sig selv"),
  upcomingLessons: jsonb("upcoming_lessons").$type<string[]>(),
  nextTargets: jsonb("next_targets").$type<Array<{ finnish: string; english: string }>>(),
  reviewOnlyNextSession: integer("review_only_next_session").notNull().default(0),
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
    correctDayCount: integer("correct_day_count").notNull().default(0),
    lastCorrectDay: text("last_correct_day"),
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
  kind: text("kind").notNull().default("practice"),
  a1Assessment: jsonb("a1_assessment").$type<A1Assessment>(),
  liveSessionId: text("live_session_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  transcript: jsonb("transcript"),
  summary: text("summary"),
  recap: jsonb("recap").$type<{ progress: string[]; needsWork: string[]; nextStep: string }>(),
  reviewState: jsonb("review_state").$type<HistoryState>(),
  status: text("status").notNull().default("started"),
  progressCursor: integer("progress_cursor").notNull().default(0),
  voiceSeconds: integer("voice_seconds").notNull().default(0),
  closeReason: text("close_reason"),
  closeConfirmed: integer("close_confirmed").notNull().default(0),
});

export const sessionDiagnostics = pgTable("session_diagnostics", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  sessionId: integer("session_id"),
  eventType: text("event_type").notNull(),
  code: text("code"),
  message: text("message"),
  details: jsonb("details").$type<Record<string, string | number | boolean | null>>(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiUsageEvents = pgTable("api_usage_events", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  responseId: text("response_id").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull(),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 16, scale: 10 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("api_usage_events_response_unique").on(table.responseId)]);

export const ideaNotes = pgTable("idea_notes", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id"),
  sourceKey: text("source_key").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("idea_notes_source_key_unique").on(table.sourceKey)]);

export const practiceItems = pgTable("practice_items", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  segmentEnd: integer("segment_end").notNull(),
  finnish: text("finnish").notNull(),
  result: text("result").notNull(),
  independent: integer("independent").notNull().default(0),
  evidence: text("evidence"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("practice_items_segment_unique").on(table.sessionId, table.segmentEnd, table.finnish)]);
