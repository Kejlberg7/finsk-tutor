import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const vocabulary = pgTable("vocabulary", {
  id: serial("id").primaryKey(),
  finnish: text("finnish").notNull(),
  english: text("english").notNull(),
  danish: text("danish"),
  example: text("example"),
  mastery: integer("mastery").notNull().default(0),
  nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
});

export const practiceSessions = pgTable("practice_sessions", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  summary: text("summary"),
});
