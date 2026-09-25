import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { checkpointPracticeSession } from "@/lib/learning";
import { cleanFragments } from "@/lib/transcript";

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown; fragments?: unknown } | null;
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
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunne ikke gemme fremskridt." },
      { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
