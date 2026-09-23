import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";

const instructions = `
You are a patient Finnish conversation tutor.

The learner speaks Danish or English. Use English for explanations unless the learner asks for Danish. Use Finnish for short target phrases and examples.

This is a repetition exercise. Say one short Finnish phrase at a time, then pause and let the learner repeat it. Do not introduce many new words at once. Correct gently: first acknowledge the attempt, then give the correct Finnish phrase slowly, followed by a short English explanation.

Prefer clear, slow Finnish pronunciation. Keep the conversation suitable for hands-free audio. Never claim that a word has been mastered; the application will track that later.
`;

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

  const response = await fetch("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: { model: "gpt-live-1", instructions },
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

  return NextResponse.json(result, {
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
