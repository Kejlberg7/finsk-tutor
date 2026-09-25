import { desc, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { practiceSessions } from "@/db/schema";
import { getSessionFromRequest } from "@/lib/auth";
import type { RecentSession } from "@/lib/learning-types";
import { cleanFragments, compactTranscript } from "@/lib/transcript";

export async function GET(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }
  if (!isDatabaseConfigured()) return NextResponse.json([]);
  try {
    await ensureDatabaseSchema();
    const rows = await getDatabase().select({
      id: practiceSessions.id,
      startedAt: practiceSessions.startedAt,
      endedAt: practiceSessions.endedAt,
      summary: practiceSessions.summary,
      status: practiceSessions.status,
      transcript: practiceSessions.transcript,
    }).from(practiceSessions).where(isNotNull(practiceSessions.transcript))
      .orderBy(desc(practiceSessions.startedAt)).limit(8);
    const history: RecentSession[] = rows.map((row) => ({
      id: row.id,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      summary: row.summary,
      status: row.status,
      transcript: Array.isArray(row.transcript) ? compactTranscript(cleanFragments(row.transcript)) : [],
    }));
    return NextResponse.json(history, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not load session history", error);
    return NextResponse.json({ error: "Kunne ikke hente samtaler." }, { status: 500 });
  }
}
