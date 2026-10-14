import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { apiUsageEvents, practiceSessions } from "@/db/schema";
import { getSessionFromRequest } from "@/lib/auth";
import { estimateResponseCostUsd, readResponseTokenUsage } from "@/lib/api-cost";
import { recordServerDiagnostic } from "@/lib/session-diagnostics-server";

export async function PATCH(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "Hukommelsen er ikke sat op." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as {
    sessionId?: unknown; attemptId?: unknown; seconds?: unknown;
    responseUsage?: { responseId?: unknown; model?: unknown; usage?: unknown };
  } | null;
  if (!body || !Number.isInteger(body.sessionId) || typeof body.sessionId !== "number"
    || (body.seconds !== undefined && (!Number.isInteger(body.seconds) || typeof body.seconds !== "number" || body.seconds < 0 || body.seconds > 86_400))) {
    return NextResponse.json({ error: "Ugyldigt API-forbrug." }, { status: 400 });
  }
  const responseUsage = body.responseUsage;
  let responseCost: { responseId: string; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number } | null = null;
  if (responseUsage !== undefined) {
    if (!responseUsage || typeof responseUsage.responseId !== "string" || responseUsage.responseId.length > 200
      || typeof responseUsage.model !== "string") {
      return NextResponse.json({ error: "Ugyldig modelusage." }, { status: 400 });
    }
    const usage = readResponseTokenUsage(responseUsage.usage);
    const costUsd = usage ? estimateResponseCostUsd(responseUsage.model, usage) : null;
    if (!usage || costUsd === null) return NextResponse.json({ error: "Ukendt model eller ugyldige token-tal." }, { status: 400 });
    responseCost = { responseId: responseUsage.responseId, model: responseUsage.model, ...usage, costUsd };
  }
  if (body.seconds === undefined && !responseCost) return NextResponse.json({ error: "Mangler API-forbrug." }, { status: 400 });
  try {
    await ensureDatabaseSchema();
    const db = getDatabase();
    const rows = await db.select({ id: practiceSessions.id }).from(practiceSessions)
      .where(eq(practiceSessions.id, body.sessionId)).limit(1);
    if (!rows[0]) return NextResponse.json({ error: "Samtalen findes ikke." }, { status: 404 });
    if (typeof body.seconds === "number") {
      await db.update(practiceSessions)
        .set({ voiceSeconds: sql`GREATEST(${practiceSessions.voiceSeconds}, ${body.seconds})` })
        .where(eq(practiceSessions.id, body.sessionId));
    }
    if (responseCost) {
      await db.insert(apiUsageEvents).values({
        sessionId: body.sessionId,
        responseId: responseCost.responseId,
        model: responseCost.model,
        inputTokens: responseCost.inputTokens,
        cachedInputTokens: responseCost.cachedInputTokens,
        outputTokens: responseCost.outputTokens,
        estimatedCostUsd: responseCost.costUsd.toFixed(10),
      }).onConflictDoNothing();
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not save voice API usage", error);
    await recordServerDiagnostic({ attemptId: body.attemptId, sessionId: body.sessionId,
      eventType: "backend.usage_failed", code: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : null, phase: "usage" });
    return NextResponse.json({ error: "Kunne ikke gemme API-forbruget." }, { status: 500 });
  }
}
