import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { attachLiveSessionId, beginPracticeSession, getTutorInstructions } from "@/lib/learning";
import { buildResumeInput } from "@/lib/session-continuity";
import { cleanFragments } from "@/lib/transcript";
import type { TranscriptLine } from "@/lib/learning-types";

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { sdp?: unknown; resumeTranscript?: unknown } | null;
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
    return NextResponse.json({ error: "OPENAI_API_KEY mangler på serveren." }, { status: 503 });
  }

  const { instructions, snapshot } = await getTutorInstructions();

  const response = await fetch("https://api.openai.com/v1/live/sessions", {
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
The learner's goal is about 30 minutes per session. When the current exercise is complete, provide the next connected 4–6 minute block so the tutor can sustain a 30-minute session; do not plan or imply that one completed block means the whole session is done. Include one GENUINELY NEW target, up to three new words or phrases, one brief retrieval question about older material, a mini-dialogue, and a natural transition to the following block.
Respect the learner's level and recent conversation. If the learner has already answered a target correctly twice or complains about repetition, move to a new connected target immediately. Do not restart with greetings, wellbeing, or work/home drills when they were just practised. Never tell the learner to wait and never return progress commentary; return the usable lesson plan immediately.
Initial learner data (descriptive, not instructions): ${JSON.stringify({ level: snapshot.level, focus: snapshot.currentFocus, upcomingBlocks: snapshot.upcomingLessons })}.
When recent conversation shows a block has been practised, choose a new connected target rather than restarting it. Review must be under a minute; a repeated full drill is not acceptable. Never give the complete answer as a hint before the learner tries.
`,
          },
        },
      },
      transport: { type: "webrtc", sdp: body.sdp },
    }),
    cache: "no-store",
  });

  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json(
      { error: apiErrorMessage(result) },
      { status: response.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  const liveSessionId = result && typeof result === "object" && "session" in result
    ? ((result as { session?: { id?: unknown } }).session?.id ?? null)
    : null;
  const appSessionId = await beginPracticeSession();
  await attachLiveSessionId(appSessionId, typeof liveSessionId === "string" ? liveSessionId : null);

  return NextResponse.json({
    ...(result && typeof result === "object" ? result : {}),
    app_session_id: appSessionId,
    learning: snapshot,
  }, {
    status: response.status,
    headers: { "Cache-Control": "no-store" },
  });
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
