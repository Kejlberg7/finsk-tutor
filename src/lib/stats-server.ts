import "server-only";
import { asc, desc, isNotNull, and, sql } from "drizzle-orm";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { apiUsageEvents, grammarSkills, practiceSessions } from "@/db/schema";
import { buildPracticeStats, type PracticeStat } from "@/lib/stats";

export type GrammarStat = {
  name: string;
  mastery: number;
  correctCount: number;
  incorrectCount: number;
};

export async function getStatsData() {
  if (!isDatabaseConfigured()) {
    return { available: false, sessions: [] as PracticeStat[], grammar: [] as GrammarStat[], practice: buildPracticeStats([]) };
  }

  try {
    await ensureDatabaseSchema();
    const db = getDatabase();
    const [rows, usageRows, grammar] = await Promise.all([
      db.select({
        id: practiceSessions.id,
        kind: practiceSessions.kind,
        startedAt: practiceSessions.startedAt,
        endedAt: practiceSessions.endedAt,
        voiceSeconds: practiceSessions.voiceSeconds,
        status: practiceSessions.status,
        closeReason: practiceSessions.closeReason,
        closeConfirmed: practiceSessions.closeConfirmed,
      }).from(practiceSessions)
        .where(and(isNotNull(practiceSessions.endedAt), isNotNull(practiceSessions.transcript)))
        .orderBy(desc(practiceSessions.startedAt)),
      db.select({
        sessionId: apiUsageEvents.sessionId,
        cost: sql<string>`COALESCE(SUM(${apiUsageEvents.estimatedCostUsd}), 0)`,
      }).from(apiUsageEvents).groupBy(apiUsageEvents.sessionId),
      db.select({
        name: grammarSkills.name,
        mastery: grammarSkills.mastery,
        correctCount: grammarSkills.correctCount,
        incorrectCount: grammarSkills.incorrectCount,
      }).from(grammarSkills).orderBy(asc(grammarSkills.mastery), desc(grammarSkills.incorrectCount)),
    ]);
    const backendCost = new Map(usageRows.map((row) => [row.sessionId, Number(row.cost)]));
    const sessions: PracticeStat[] = rows.map((row) => {
      const durationSeconds = row.voiceSeconds > 0
        ? row.voiceSeconds
        : Math.max(0, Math.floor(((row.endedAt?.getTime() ?? row.startedAt.getTime()) - row.startedAt.getTime()) / 1_000));
      return {
        id: row.id,
        kind: row.kind === "a1_test" ? "a1_test" : "practice",
        startedAt: row.startedAt.toISOString(),
        durationSeconds,
        estimatedCostUsd: Number((durationSeconds * 0.05 / 60 + (backendCost.get(row.id) ?? 0)).toFixed(4)),
        status: row.status,
        closeReason: row.closeReason,
        closeConfirmed: row.closeConfirmed === 1,
      };
    });

    return { available: true, sessions, grammar, practice: buildPracticeStats(sessions) };
  } catch (error) {
    console.error("Could not load statistics", error);
    return { available: false, sessions: [] as PracticeStat[], grammar: [] as GrammarStat[], practice: buildPracticeStats([]) };
  }
}
