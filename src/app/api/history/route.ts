import { desc, inArray, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { apiUsageEvents, practiceSessions } from "@/db/schema";
import { getSessionFromRequest } from "@/lib/auth";
import type { RecentSession } from "@/lib/learning-types";
import { cleanFragments, compactTranscript } from "@/lib/transcript";

export async function GET(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }
  if (!isDatabaseConfigured()) return NextResponse.json([]);
  try {
    await ensureDatabaseSchema();
    const db = getDatabase();
    const rows = await db.select({
      id: practiceSessions.id,
      kind: practiceSessions.kind,
      a1Assessment: practiceSessions.a1Assessment,
      startedAt: practiceSessions.startedAt,
      endedAt: practiceSessions.endedAt,
      voiceSeconds: practiceSessions.voiceSeconds,
      summary: practiceSessions.summary,
      recap: practiceSessions.recap,
      status: practiceSessions.status,
      closeReason: practiceSessions.closeReason,
      closeConfirmed: practiceSessions.closeConfirmed,
      transcript: practiceSessions.transcript,
    }).from(practiceSessions).where(isNotNull(practiceSessions.transcript))
      .orderBy(desc(practiceSessions.startedAt)).limit(8);
    const sessionIds = rows.map((row) => row.id);
    const usageRows = sessionIds.length
      ? await db.select({ sessionId: apiUsageEvents.sessionId, cost: apiUsageEvents.estimatedCostUsd })
        .from(apiUsageEvents).where(inArray(apiUsageEvents.sessionId, sessionIds))
      : [];
    const backendCosts = new Map<number, number>();
    for (const usage of usageRows) backendCosts.set(usage.sessionId, (backendCosts.get(usage.sessionId) ?? 0) + Number(usage.cost));
    const history: RecentSession[] = rows.map((row) => {
      const durationSeconds = row.voiceSeconds || Math.max(0, Math.floor(((row.endedAt?.getTime() ?? Date.now()) - row.startedAt.getTime()) / 1_000));
      return {
      id: row.id,
      kind: row.kind === "a1_test" ? "a1_test" : "practice",
      a1Assessment: row.a1Assessment,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      durationSeconds,
      estimatedApiCostUsd: Number((durationSeconds * 0.05 / 60 + (backendCosts.get(row.id) ?? 0)).toFixed(4)),
      summary: row.summary,
      recap: row.recap,
      status: row.status,
      closeReason: row.closeReason,
      closeConfirmed: row.closeConfirmed === 1,
      transcript: Array.isArray(row.transcript) ? compactTranscript(cleanFragments(row.transcript)) : [],
      };
    });
    return NextResponse.json(history, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not load session history", error);
    return NextResponse.json({ error: "Kunne ikke hente samtaler." }, { status: 500 });
  }
}
