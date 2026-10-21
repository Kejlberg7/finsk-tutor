import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getSessionFromRequest } from "@/lib/auth";
import { ensureDatabaseSchema, getDatabase } from "@/db";
import { practiceSessions } from "@/db/schema";
import { getPracticeHistory } from "@/lib/practice-history-server";
import { parseHistoryQuery, phraseKey } from "@/lib/practice-history";
import { saveFeedbackNote } from "@/lib/feedback-notes";
import { extractIdeaCues } from "@/lib/idea-cue";
import { cleanFragments, learnerUtterances } from "@/lib/transcript";
import { recordServerDiagnostic } from "@/lib/session-diagnostics-server";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!(await getSessionFromRequest(request))) return NextResponse.json({ error: "Ikke logget ind." }, { status: 401, headers });
  const body = await request.json().catch(() => null);
  if (!body || !Number.isSafeInteger(body.sessionId) || body.sessionId < 1
    || !["get_practice_history", "save_feedback"].includes(body.name)
    || typeof body.callId !== "string" || body.callId.length > 150) {
    return NextResponse.json({ error: "Ugyldigt værktøjskald." }, { status: 400, headers });
  }
  try {
    await ensureDatabaseSchema();
    const session = (await getDatabase().select().from(practiceSessions).where(eq(practiceSessions.id, body.sessionId)).limit(1))[0];
    if (!session || session.kind !== "practice") return NextResponse.json({ error: "Øvesamtalen findes ikke." }, { status: 404, headers });
    if (body.name === "get_practice_history") {
      const query = parseHistoryQuery(body.arguments);
      if (!query) return NextResponse.json({ error: "Ugyldige historikfiltre." }, { status: 400, headers });
      return NextResponse.json(await getPracticeHistory(query, undefined, body.sessionId), { headers });
    }
    const args = body.arguments;
    if (!args || typeof args.utterance !== "string" || args.utterance.length < 15 || args.utterance.length > 2000
      || typeof args.content !== "string" || args.content.length < 5 || args.content.length > 1500
      || !["idea", "correction"].includes(args.kind)) {
      return NextResponse.json({ error: "Ugyldig feedback." }, { status: 400, headers });
    }
    const fragments = cleanFragments(body.fragments ?? session.transcript ?? []);
    const quote = phraseKey(args.utterance);
    if (!learnerUtterances(fragments).some((text) => phraseKey(text).includes(quote))) {
      return NextResponse.json({ error: "Noten mangler et citat fra din egen tale." }, { status: 400, headers });
    }
    const cues = extractIdeaCues(args.utterance);
    const direct = cues.find((cue) => cue.explicit) ?? cues[0];
    const note = await saveFeedbackNote(body.sessionId, direct ?? { content: args.content, kind: args.kind });
    if (!note) throw new Error("Noten kunne ikke gemmes.");
    return NextResponse.json({ saved: true, noteId: note.id, content: note.content }, { headers });
  } catch (error) {
    await recordServerDiagnostic({ attemptId: body.attemptId, sessionId: body.sessionId,
      eventType: "backend.tool_failed", code: body.name, message: error instanceof Error ? error.message : null });
    return NextResponse.json({ error: "Opslaget eller notegemningen mislykkedes. Gæt ikke resultatet; prøv igen senere." }, { status: 500, headers });
  }
}
