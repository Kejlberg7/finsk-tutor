import { NextResponse } from "next/server";
import { desc, isNotNull } from "drizzle-orm";
import { getSessionFromRequest } from "@/lib/auth";
import { ensureDatabaseSchema, getDatabase } from "@/db";
import { practiceSessions } from "@/db/schema";
import { cleanFragments } from "@/lib/transcript";
import { collectTranscriptFeedback } from "@/lib/feedback-notes";

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  try {
    await ensureDatabaseSchema();
    const sessions = await getDatabase().select({ id: practiceSessions.id, transcript: practiceSessions.transcript })
      .from(practiceSessions).where(isNotNull(practiceSessions.transcript)).orderBy(desc(practiceSessions.startedAt)).limit(8);
    const ids = new Set<number>();
    for (const session of sessions) {
      const notes = await collectTranscriptFeedback(session.id, cleanFragments(session.transcript));
      for (const note of notes) ids.add(note.id);
    }
    return NextResponse.json({ checked: sessions.length, found: ids.size }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Kunne ikke gennemgå de tidligere samtaler. Prøv igen senere." }, { status: 500 });
  }
}
