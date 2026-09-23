import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { completePracticeSession } from "@/lib/learning";
import type { TranscriptLine } from "@/lib/learning-types";

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    sessionId?: unknown;
    transcript?: unknown;
  } | null;

  if (!Number.isInteger(body?.sessionId) || typeof body?.sessionId !== "number") {
    return NextResponse.json({ error: "Mangler et gyldigt sessionsnummer." }, { status: 400 });
  }
  if (!Array.isArray(body.transcript)) {
    return NextResponse.json({ error: "Mangler samtaletranskript." }, { status: 400 });
  }

  const transcript = body.transcript.filter(isTranscriptLine).slice(-80);
  if (!transcript.length) {
    return NextResponse.json({ error: "Samtalen havde intet transkript at gemme." }, { status: 400 });
  }

  try {
    const learning = await completePracticeSession(body.sessionId, transcript);
    return NextResponse.json({ ok: true, learning }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not complete practice session", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke gemme samtalen." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function isTranscriptLine(value: unknown): value is TranscriptLine {
  if (!value || typeof value !== "object") return false;
  const item = value as { speaker?: unknown; text?: unknown };
  return (item.speaker === "dig" || item.speaker === "tutor") && typeof item.text === "string";
}
