import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { checkpointPracticeSession } from "@/lib/learning";
import { cleanFragments } from "@/lib/transcript";
import { recordServerDiagnostic } from "@/lib/session-diagnostics-server";

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown; attemptId?: unknown; fragments?: unknown } | null;
  if (!Number.isInteger(body?.sessionId) || typeof body?.sessionId !== "number") {
    return NextResponse.json({ error: "Mangler et gyldigt sessionsnummer." }, { status: 400 });
  }
  let fragments;
  try {
    fragments = cleanFragments(body.fragments);
  } catch {
    return NextResponse.json({ error: "Ugyldigt samtaletranskript." }, { status: 400 });
  }
  try {
    const progress = await checkpointPracticeSession(body.sessionId, fragments);
    return NextResponse.json(progress, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not save live progress", error);
    await recordServerDiagnostic({ attemptId: body.attemptId, sessionId: body.sessionId,
      eventType: "backend.checkpoint_failed", code: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : null, phase: "progress" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunne ikke gemme fremskridt." },
      { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
