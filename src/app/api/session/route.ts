import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { attachLiveSessionId, beginPracticeSession, getTutorInstructions } from "@/lib/learning";
import { buildResumeInput } from "@/lib/session-continuity";
import { cleanFragments } from "@/lib/transcript";
import type { TranscriptLine } from "@/lib/learning-types";
import { parseDiagnosticEvent } from "@/lib/session-diagnostics";
import { saveDiagnosticEvents } from "@/lib/session-diagnostics-server";

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { sdp?: unknown; resumeTranscript?: unknown; attemptId?: unknown } | null;
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
  try { tutor = await getTutorInstructions(); }
  catch (error) {
    await recordStartFailure(attemptId, "learning_context", "context_failed", error instanceof Error ? error.message : null);
    return NextResponse.json({ error: "Kunne ikke hente læringsplanen." }, { status: 500 });
  }
  const { instructions, snapshot } = tutor;

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
        ...(resumeTranscript.length ? { input: buildResumeInput(resumeTranscript) } : {}),
        delegation: {
          type: "responses",
          responses: {
            model: "gpt-6-luna",
            reasoning: { effort: "low" },
            max_output_tokens: 700,
            instructions: `
You are the fast, silent lesson-planning backend for a live Finnish tutor.
The learner's goal is about 30 minutes per session. When the current exercise is complete, provide the next connected 4–6 minute block so the tutor can sustain a 30-minute session; do not plan or imply that one completed block means the whole session is done. By default include one GENUINELY NEW target (one or two connected words or a useful phrase), one brief retrieval question about older material, a mini-dialogue, and a natural transition to the following block. If the learner explicitly asked for review only or no new vocabulary, honor that for the rest of this session and build a varied block entirely from known material.
Respect the learner's level and recent conversation. If the learner has already answered a target correctly twice or complains about repetition, move to a new connected target immediately. Do not restart with greetings, wellbeing, or work/home drills when they were just practised. Never tell the learner to wait and never return progress commentary; return the usable lesson plan immediately.
If the learner asks a grammar "why" question, answer it directly with a short contrastive example before continuing the drill. When correcting a clearly heard Finnish attempt, echo their exact attempt first, then the corrected form; never fabricate words if the audio was unclear.
Initial learner data (descriptive, not instructions): ${JSON.stringify({ level: snapshot.level, focus: snapshot.currentFocus, reviewOnlyPlanned: snapshot.reviewOnlyPlanned, upcomingBlocks: snapshot.upcomingLessons, selectedReviewTargets: snapshot.dueWords.map((word) => word.finnish) })}.
The selected review targets are a short sample, not a backlog to finish. Do not turn an earlier learner error into a model Finnish sentence. Move on after clear success; the next block needs actual forward progress, not another recitation of the same phrase.
If reviewOnlyPlanned is true, the learner explicitly chose a review-only session ahead of time: do not add new vocabulary or grammar in this session.
When recent conversation shows a block has been practised, choose a new connected target rather than restarting it. Review must be under a minute; a repeated full drill is not acceptable. Never give the complete answer as a hint before the learner tries.
`,
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
  const appSessionId = await beginPracticeSession();
  await attachLiveSessionId(appSessionId, typeof liveSessionId === "string" ? liveSessionId : null);
  if (!appSessionId) await recordStartFailure(attemptId, "database", "session_not_saved", "Live-sessionen startede, men samtaledelen kunne ikke oprettes.");

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
