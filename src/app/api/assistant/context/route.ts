import { desc, inArray, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { apiUsageEvents, ideaNotes, practiceSessions, sessionDiagnostics } from "@/db/schema";
import { isAuthorizedTutorReadRequest } from "@/lib/tutor-read-api-auth";
import type { RecentSession } from "@/lib/learning-types";
import { cleanFragments, compactTranscript } from "@/lib/transcript";

export async function GET(request: Request) {
  const noStore = { "Cache-Control": "no-store" };
  if (!process.env.TUTOR_READ_API_TOKEN || process.env.TUTOR_READ_API_TOKEN.length < 40) {
    return NextResponse.json({ error: "Læse-API'et er ikke konfigureret." }, { status: 503, headers: noStore });
  }
  if (!isAuthorizedTutorReadRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Ugyldig API-token." }, { status: 401, headers: noStore });
  }
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Læringsdatabasen er ikke tilgængelig." }, { status: 503, headers: noStore });
  }

  const url = new URL(request.url);
  const sessionLimit = readBoundedLimit(url.searchParams.get("sessions"), 5, 20);
  const noteLimit = readBoundedLimit(url.searchParams.get("notes"), 50, 100);
  const diagnosticLimit = readBoundedLimit(url.searchParams.get("diagnostics"), 100, 500);

  try {
    await ensureDatabaseSchema();
    const db = getDatabase();
    const rows = await db.select({
      id: practiceSessions.id,
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
      .orderBy(desc(practiceSessions.startedAt)).limit(sessionLimit);

    const sessionIds = rows.map((row) => row.id);
    const usageRows = sessionIds.length
      ? await db.select({ sessionId: apiUsageEvents.sessionId, cost: apiUsageEvents.estimatedCostUsd })
        .from(apiUsageEvents).where(inArray(apiUsageEvents.sessionId, sessionIds))
      : [];
    const backendCosts = new Map<number, number>();
    for (const usage of usageRows) {
      backendCosts.set(usage.sessionId, (backendCosts.get(usage.sessionId) ?? 0) + Number(usage.cost));
    }

    const sessions: RecentSession[] = rows.map((row) => {
      const durationSeconds = row.voiceSeconds || Math.max(0, Math.floor(
        ((row.endedAt?.getTime() ?? Date.now()) - row.startedAt.getTime()) / 1_000,
      ));
      return {
        id: row.id,
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

    const notes = await db.select({
      id: ideaNotes.id,
      sessionId: ideaNotes.sessionId,
      kind: ideaNotes.kind,
      content: ideaNotes.content,
      status: ideaNotes.status,
      createdAt: ideaNotes.createdAt,
    }).from(ideaNotes).orderBy(desc(ideaNotes.createdAt)).limit(noteLimit);

    const diagnostics = await db.select({
      id: sessionDiagnostics.id,
      attemptId: sessionDiagnostics.attemptId,
      sessionId: sessionDiagnostics.sessionId,
      eventType: sessionDiagnostics.eventType,
      code: sessionDiagnostics.code,
      message: sessionDiagnostics.message,
      details: sessionDiagnostics.details,
      occurredAt: sessionDiagnostics.occurredAt,
      receivedAt: sessionDiagnostics.createdAt,
    }).from(sessionDiagnostics).orderBy(desc(sessionDiagnostics.occurredAt)).limit(diagnosticLimit);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      sessions,
      diagnostics,
      notes: notes.map((note) => ({
        id: note.id,
        sessionId: note.sessionId,
        kind: note.kind === "correction" ? "correction" : "idea",
        content: note.content,
        status: note.status === "done" ? "done" : "open",
        createdAt: note.createdAt.toISOString(),
      })),
    }, { headers: noStore });
  } catch (error) {
    console.error("Could not load assistant context", error);
    return NextResponse.json({ error: "Kunne ikke hente samtaler og noter." }, { status: 500, headers: noStore });
  }
}

function readBoundedLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(1, parsed)) : fallback;
}
