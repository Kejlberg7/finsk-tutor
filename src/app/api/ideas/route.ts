import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { ideaNotes, practiceSessions } from "@/db/schema";
import { getSessionFromRequest } from "@/lib/auth";
import { extractIdeaCue } from "@/lib/idea-cue";
import type { IdeaNote } from "@/lib/learning-types";

export async function GET(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }
  if (!isDatabaseConfigured()) return NextResponse.json([]);
  try {
    await ensureDatabaseSchema();
    const rows = await getDatabase().select().from(ideaNotes).orderBy(desc(ideaNotes.createdAt)).limit(50);
    return NextResponse.json(rows.map(toIdeaNote), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not load idea notes", error);
    return NextResponse.json({ error: "Kunne ikke hente idéer." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "Hukommelsen er ikke sat op." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as {
    sessionId?: unknown; sourceKey?: unknown; utterance?: unknown;
  } | null;
  if (!Number.isInteger(body?.sessionId) || typeof body?.sessionId !== "number"
    || typeof body.sourceKey !== "string" || !/^[0-9a-f-]{36}$/i.test(body.sourceKey)
    || typeof body.utterance !== "string" || body.utterance.length > 2_000) {
    return NextResponse.json({ error: "Ugyldig note." }, { status: 400 });
  }
  const cue = extractIdeaCue(body.utterance);
  if (!cue) return NextResponse.json({ error: "Sig fx 'Notér idé: ...' for at gemme en note." }, { status: 400 });
  try {
    await ensureDatabaseSchema();
    const db = getDatabase();
    const session = await db.select({ id: practiceSessions.id }).from(practiceSessions)
      .where(eq(practiceSessions.id, body.sessionId)).limit(1);
    if (!session.length) return NextResponse.json({ error: "Samtalen findes ikke." }, { status: 404 });
    const inserted = await db.insert(ideaNotes).values({
      sessionId: body.sessionId,
      sourceKey: body.sourceKey,
      kind: cue.kind,
      content: cue.content,
    }).onConflictDoNothing().returning();
    const row = inserted[0] ?? (await db.select().from(ideaNotes).where(eq(ideaNotes.sourceKey, body.sourceKey)).limit(1))[0];
    if (!row) throw new Error("Noten kunne ikke gemmes.");
    return NextResponse.json(toIdeaNote(row), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not save idea note", error);
    return NextResponse.json({ error: "Kunne ikke gemme noten." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!(await getSessionFromRequest(request))) {
    return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown; status?: unknown } | null;
  if (!Number.isInteger(body?.id) || typeof body?.id !== "number" || (body.status !== "open" && body.status !== "done")) {
    return NextResponse.json({ error: "Ugyldig opdatering." }, { status: 400 });
  }
  try {
    await ensureDatabaseSchema();
    const rows = await getDatabase().update(ideaNotes).set({ status: body.status })
      .where(eq(ideaNotes.id, body.id)).returning();
    if (!rows[0]) return NextResponse.json({ error: "Noten findes ikke." }, { status: 404 });
    return NextResponse.json(toIdeaNote(rows[0]), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not update idea note", error);
    return NextResponse.json({ error: "Kunne ikke opdatere noten." }, { status: 500 });
  }
}

function toIdeaNote(row: typeof ideaNotes.$inferSelect): IdeaNote {
  return {
    id: row.id,
    kind: row.kind === "correction" ? "correction" : "idea",
    content: row.content,
    status: row.status === "done" ? "done" : "open",
    createdAt: row.createdAt.toISOString(),
  };
}
