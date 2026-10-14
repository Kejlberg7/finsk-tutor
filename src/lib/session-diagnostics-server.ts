import "server-only";
import { and, eq } from "drizzle-orm";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { practiceSessions, sessionDiagnostics } from "@/db/schema";
import type { DiagnosticEvent } from "@/lib/session-diagnostics";
import { parseDiagnosticEvent } from "@/lib/session-diagnostics";

export async function saveDiagnosticEvents(events: DiagnosticEvent[]): Promise<void> {
  if (!events.length || !isDatabaseConfigured()) return;
  await ensureDatabaseSchema();
  const db = getDatabase();
  for (const event of events) {
    await db.insert(sessionDiagnostics).values({
      id: event.id,
      attemptId: event.attemptId,
      sessionId: event.sessionId,
      eventType: event.eventType,
      code: event.code,
      message: event.message,
      details: event.details,
      occurredAt: new Date(event.occurredAt),
    }).onConflictDoNothing();
    if (!event.sessionId) continue;
    if (event.eventType === "live.session_closed") {
      await db.update(practiceSessions).set({ closeReason: event.code, closeConfirmed: 1 })
        .where(eq(practiceSessions.id, event.sessionId));
    } else if (event.eventType === "client.finish") {
      await db.update(practiceSessions).set({ closeReason: event.code })
        .where(and(eq(practiceSessions.id, event.sessionId), eq(practiceSessions.closeConfirmed, 0)));
    }
  }
}

export async function recordServerDiagnostic(input: {
  attemptId?: unknown; sessionId: number | null; eventType: string; code: string; message?: string | null;
  phase?: string;
}): Promise<void> {
  const event = parseDiagnosticEvent({
    id: crypto.randomUUID(), attemptId: typeof input.attemptId === "string" ? input.attemptId : crypto.randomUUID(),
    sessionId: input.sessionId, eventType: input.eventType, code: input.code,
    message: input.message ?? null, details: input.phase ? { phase: input.phase } : null,
    occurredAt: new Date().toISOString(),
  });
  if (!event) return;
  try { await saveDiagnosticEvents([event]); }
  catch (error) { console.error("Could not record backend diagnostic", error); }
}
