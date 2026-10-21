import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { attachLiveSessionId, beginPracticeSession, getTutorInstructions } from "@/lib/learning";
import { buildResumeInput } from "@/lib/session-continuity";
import { cleanFragments } from "@/lib/transcript";
import type { TranscriptLine } from "@/lib/learning-types";
import { parseDiagnosticEvent } from "@/lib/session-diagnostics";
import { recordServerDiagnostic, saveDiagnosticEvents } from "@/lib/session-diagnostics-server";
import type { SessionKind } from "@/lib/a1-test";
import { TUTOR_TOOLS, TUTOR_VERSION } from "@/lib/tutor-prompts";
import { getPracticeHistory } from "@/lib/practice-history-server";
import { ensureDatabaseSchema, getDatabase } from "@/db";
import { practiceSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { historyPage, type HistoryState } from "@/lib/practice-history";

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { sdp?: unknown; resumeTranscript?: unknown; resumeFromSessionId?: unknown; attemptId?: unknown; kind?: unknown } | null;
  if (body?.kind !== undefined && body.kind !== "practice" && body.kind !== "a1_test") {
    return NextResponse.json({ error: "Ugyldig samtaletype." }, { status: 400 });
  }
  const kind: SessionKind = body?.kind === "a1_test" ? "a1_test" : "practice";
  const attemptId = typeof body?.attemptId === "string" && /^[0-9a-f-]{36}$/i.test(body.attemptId)
    ? body.attemptId : crypto.randomUUID();
  if (typeof body?.sdp !== "string" || !body.sdp.trim()) {
    return NextResponse.json({ error: "Mangler SDP-offer." }, { status: 400 });
  }
  let resumeTranscript: TranscriptLine[] = [];
  if (body.resumeTranscript !== undefined) {
    try {
      resumeTranscript = cleanFragments(body.resumeTranscript);
      if (resumeTranscript.length > 200) throw new Error("For langt transkript.");
    } catch {
      return NextResponse.json({ error: "Ugyldig genoptagelseskontekst." }, { status: 400 });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await recordStartFailure(attemptId, "configuration", "missing_api_key", "OPENAI_API_KEY mangler på serveren.");
    return NextResponse.json({ error: "OPENAI_API_KEY mangler på serveren." }, { status: 503 });
  }

  let tutor;
  try { tutor = await getTutorInstructions(kind); }
  catch (error) {
    await recordStartFailure(attemptId, "learning_context", "context_failed", error instanceof Error ? error.message : null);
    return NextResponse.json({ error: "Kunne ikke hente læringsplanen." }, { status: 500 });
  }
  const { instructions, snapshot } = tutor;
  if (kind === "a1_test" && (!snapshot.memoryReady || !snapshot.a1Test.eligible)) {
    return NextResponse.json({ error: "A1-taletesten bliver tilgængelig ved 100 stærke udtryk." }, { status: 403 });
  }

  const input = kind === "practice" ? buildResumeInput(resumeTranscript) : [];
  let previousReview: HistoryState | null = null;
  if (snapshot.memoryReady && resumeTranscript.length && Number.isSafeInteger(body.resumeFromSessionId)) {
    try {
      await ensureDatabaseSchema();
      previousReview = (await getDatabase().select({ state: practiceSessions.reviewState }).from(practiceSessions)
        .where(eq(practiceSessions.id, Number(body.resumeFromSessionId))).limit(1))[0]?.state ?? null;
    } catch {
      await recordStartFailure(attemptId, "resume_context", "context_failed", "Den gemte repetitionsliste kunne ikke hentes.");
      return NextResponse.json({ error: "Kunne ikke hente den afbrudte samtales øveliste. Prøv igen." }, { status: 503 });
    }
  }
  if (kind === "practice" && snapshot.memoryReady) {
    try {
      const recent = previousReview ? historyPage(previousReview, previousReview.lastOffset, 8)
        : await getPracticeHistory({ scope: "recent_days", days: 7, query: "", offset: 0, limit: 6 }, snapshot);
      input.unshift({ type: "message", role: "developer", content: [{ type: "input_text",
        text: `${previousReview ? "Verified active review page from the interrupted call. Use the transcript to find the unfinished item; do not restart the set." : "Verified initial history data. This is only page one; use get_practice_history for more."} These are factual records: ${JSON.stringify(recent)}` }] });
    } catch { /* The lookup tool can report availability explicitly later. */ }
  }

  let response: Response;
  try { response = await fetch("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        model: "gpt-live-1",
        instructions,
        ...(input.length ? { input } : {}),
        delegation: {
          type: "responses",
          responses: {
            model: "gpt-6-luna",
            reasoning: { effort: "low" },
            max_output_tokens: 1400,
            ...(kind === "practice" ? { tools: TUTOR_TOOLS, tool_choice: "auto", parallel_tool_calls: false } : {}),
            instructions: kind === "a1_test" ? `
You are the silent backend for an INTERNAL ORAL A1 check. Help the live tutor administer four independent tasks: introduction, Finnish-only comprehension, two-way interaction including one learner-generated Finnish question, and one everyday role-play. Give the next short test prompt, not a lesson. Do not reveal answers, coach, translate the Finnish prompt before the learner answers, assign a score, or say that the learner passed. The app evaluates the saved transcript afterward. If a task is done, move to a different task. Stay in test mode until the learner stops.
` : tutor.backendInstructions,
          },
        },
      },
      transport: { type: "webrtc", sdp: body.sdp },
    }),
    cache: "no-store",
  }); } catch (error) {
    await recordStartFailure(attemptId, "openai_request", "network_error", error instanceof Error ? error.message : null);
    return NextResponse.json({ error: "Forbindelsen til OpenAI mislykkedes." }, { status: 502 });
  }

  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    await recordStartFailure(attemptId, "openai_response", "http_error", apiErrorMessage(result), response.status,
      response.headers.get("x-request-id"));
    return NextResponse.json(
      { error: apiErrorMessage(result) },
      { status: response.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!result || typeof result !== "object" || !("transport" in result)
    || typeof (result as { transport?: { sdp?: unknown } }).transport?.sdp !== "string") {
    await recordStartFailure(attemptId, "openai_response", "missing_sdp", "OpenAI returnerede ikke et SDP-svar.", response.status,
      response.headers.get("x-request-id"));
    return NextResponse.json({ error: "OpenAI returnerede ikke et SDP-svar." }, { status: 502 });
  }

  const liveSessionId = result && typeof result === "object" && "session" in result
    ? ((result as { session?: { id?: unknown } }).session?.id ?? null)
    : null;
  const appSessionId = await beginPracticeSession(kind);
  await attachLiveSessionId(appSessionId, typeof liveSessionId === "string" ? liveSessionId : null);
  if (appSessionId && previousReview) await getDatabase().update(practiceSessions)
    .set({ reviewState: previousReview }).where(eq(practiceSessions.id, appSessionId)).catch(async () => {
      await recordServerDiagnostic({ attemptId, sessionId: appSessionId,
        eventType: "backend.resume_state_failed", code: "review_state", phase: "resume" });
    });
  const created = parseDiagnosticEvent({ id: crypto.randomUUID(), attemptId, sessionId: appSessionId,
    eventType: "backend.session_configured", code: TUTOR_VERSION, message: null,
    details: { responseId: response.headers.get("x-request-id"), liveSessionId: typeof liveSessionId === "string" ? liveSessionId : null },
    occurredAt: new Date().toISOString() });
  if (created) await saveDiagnosticEvents([created]).catch(() => undefined);
  if (!appSessionId) await recordStartFailure(attemptId, "database", "session_not_saved", "Live-sessionen startede, men samtaledelen kunne ikke oprettes.");
  if (!appSessionId && kind === "a1_test") {
    return NextResponse.json({ error: "A1-taletesten kunne ikke gemmes. Prøv igen senere." }, { status: 503 });
  }

  return NextResponse.json({
    ...(result && typeof result === "object" ? result : {}),
    app_session_id: appSessionId,
    learning: snapshot,
  }, {
    status: response.status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function recordStartFailure(attemptId: string, phase: string, code: string, message: string | null, httpStatus?: number, responseId?: string | null) {
  const event = parseDiagnosticEvent({
    id: crypto.randomUUID(), attemptId, sessionId: null, eventType: "backend.session_create_failed",
    code, message, details: { phase, ...(httpStatus ? { httpStatus } : {}), ...(responseId ? { responseId } : {}) }, occurredAt: new Date().toISOString(),
  });
  if (!event) return;
  try { await saveDiagnosticEvents([event]); }
  catch (error) { console.error("Could not record session creation failure", error); }
}

function apiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "OpenAI afviste forbindelsen.";
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "OpenAI afviste forbindelsen.";
}
