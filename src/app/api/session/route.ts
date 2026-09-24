import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { attachLiveSessionId, beginPracticeSession, getTutorInstructions } from "@/lib/learning";

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { sdp?: unknown } | null;
  if (typeof body?.sdp !== "string" || !body.sdp.trim()) {
    return NextResponse.json({ error: "Mangler SDP-offer." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY mangler på serveren." }, { status: 503 });
  }

  const [{ instructions, snapshot }, appSessionId] = await Promise.all([
    getTutorInstructions(),
    beginPracticeSession(),
  ]);

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
        delegation: {
          type: "responses",
          responses: {
            model: "gpt-6-luna",
            reasoning: { effort: "low" },
            max_output_tokens: 700,
            instructions: `
You are the fast, silent lesson-planning backend for a live Finnish tutor.
When the learner wants to continue or the current exercise is complete, provide a concise plan for the next connected 4–6 minute lesson block. Include one target, up to three new words or phrases, a repetition drill, a mini-dialogue, and a natural transition to the following block.
Respect the learner's level and recent conversation. Prefer steady progression over repeating an already completed exercise. Never tell the learner to wait and never return progress commentary; return the usable lesson plan immediately.
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
