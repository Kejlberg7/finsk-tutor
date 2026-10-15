import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { completePracticeSession } from "@/lib/learning";
import { cleanFragments } from "@/lib/transcript";
import { recordServerDiagnostic } from "@/lib/session-diagnostics-server";

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    sessionId?: unknown;
    attemptId?: unknown;
    transcript?: unknown;
    interrupted?: unknown;
  } | null;

  if (!Number.isInteger(body?.sessionId) || typeof body?.sessionId !== "number") {
    return NextResponse.json({ error: "Mangler et gyldigt sessionsnummer." }, { status: 400 });
  }
  let transcript;
  try {
    transcript = cleanFragments(body.transcript);
  } catch {
    return NextResponse.json({ error: "Ugyldigt samtaletranskript." }, { status: 400 });
  }
  if (!transcript.length) {
    return NextResponse.json({ error: "Samtalen havde intet transkript at gemme." }, { status: 400 });
  }

  try {
    const learning = await completePracticeSession(body.sessionId, transcript, body.interrupted === true);
    return NextResponse.json({ ok: true, learning }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not complete practice session", error);
    await recordServerDiagnostic({ attemptId: body.attemptId, sessionId: body.sessionId,
      eventType: "backend.complete_failed", code: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : null, phase: "analysis" });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke gemme samtalen." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
