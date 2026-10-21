import "server-only";
import { desc, eq, gte, inArray } from "drizzle-orm";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { expressionAttempts, practiceItems, practiceSessions } from "@/db/schema";
import { getLearningSnapshot } from "./learning";
import { buildPracticeHistory, historyPage, historyQueryKey, type HistoryQuery } from "./practice-history";
import { cleanFragments } from "./transcript";
import type { LearningSnapshot } from "./learning-types";

export async function getPracticeHistory(query: HistoryQuery, snapshot?: LearningSnapshot, sessionId?: number) {
  if (!isDatabaseConfigured()) throw new Error("Øvehistorikken er ikke tilgængelig.");
  await ensureDatabaseSchema();
  const db = getDatabase();
  const now = new Date();
  if (sessionId) {
    const cached = (await db.select({ state: practiceSessions.reviewState }).from(practiceSessions)
      .where(eq(practiceSessions.id, sessionId)).limit(1))[0]?.state;
    if (cached?.queryKey === historyQueryKey(query)) {
      await db.update(practiceSessions).set({ reviewState: { ...cached, lastOffset: query.offset } }).where(eq(practiceSessions.id, sessionId));
      return historyPage(cached, query.offset, query.limit);
    }
  }
  const [memory, rows] = await Promise.all([
    snapshot ?? getLearningSnapshot(),
    db.select({ id: practiceSessions.id, startedAt: practiceSessions.startedAt, transcript: practiceSessions.transcript })
      .from(practiceSessions).where(gte(practiceSessions.startedAt, new Date(now.getTime() - 32 * 86400_000)))
      .orderBy(desc(practiceSessions.startedAt)),
  ]);
  if (!memory.memoryReady) throw new Error("Ordlisten kunne ikke hentes.");
  const sessions = rows.map((row) => ({ id: row.id, startedAt: row.startedAt.toISOString(),
    transcript: Array.isArray(row.transcript) ? cleanFragments(row.transcript) : [] }));
  const records = sessions.length ? await db.select().from(practiceItems)
    .where(inArray(practiceItems.sessionId, sessions.map((s) => s.id))) : [];
  const attempts = sessions.length ? await db.select().from(expressionAttempts)
    .where(inArray(expressionAttempts.sessionId, sessions.map((s) => s.id))) : [];
  const result = buildPracticeHistory(memory.wordProgress, sessions,
    [...records, ...attempts].map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() })), { ...query, offset: 0, limit: 50_000 }, now);
  const state = { queryKey: historyQueryKey(query), asOf: now.toISOString(), lastOffset: query.offset, result };
  if (sessionId) await db.update(practiceSessions).set({ reviewState: state }).where(eq(practiceSessions.id, sessionId));
  return historyPage(state, query.offset, query.limit);
}
