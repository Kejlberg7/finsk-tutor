import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ensureDatabaseSchema, getDatabase } from "@/db";
import { ideaNotes, practiceSessions } from "@/db/schema";
import { extractIdeaCues, type IdeaCue } from "./idea-cue";
import type { TranscriptLine } from "./learning-types";
import { learnerUtterances } from "./transcript";
import { phraseKey } from "./practice-history";

export async function saveFeedbackNote(sessionId: number, cue: Pick<IdeaCue, "kind" | "content">) {
  await ensureDatabaseSchema();
  const db = getDatabase();
  const content = cue.content.trim().slice(0, 1500);
  if (content.length < 5) throw new Error("Noten er for kort.");
  const sourceKey = `feedback:${sessionId}:${createHash("sha256").update(`${cue.kind}:${phraseKey(content)}`).digest("hex")}`;
  // Group recurring reports while open; a later regression after resolution can create a new note.
  const existing = await db.select().from(ideaNotes).where(and(eq(ideaNotes.content, content), eq(ideaNotes.status, "open"))).limit(1);
  if (existing[0]) return existing[0];
  const resolved = (await db.select().from(ideaNotes).where(and(eq(ideaNotes.content, content), eq(ideaNotes.status, "done")))
    .orderBy(desc(ideaNotes.createdAt)).limit(1))[0];
  if (resolved) {
    const session = (await db.select({ startedAt: practiceSessions.startedAt }).from(practiceSessions)
      .where(eq(practiceSessions.id, sessionId)).limit(1))[0];
    if (session && session.startedAt <= resolved.createdAt) return resolved;
  }
  const sameSession = await db.select().from(ideaNotes).where(and(eq(ideaNotes.sessionId, sessionId), eq(ideaNotes.status, "open")));
  const partial = sameSession.find((note) => Math.min(phraseKey(note.content).length, phraseKey(content).length) >= 40
    && (phraseKey(note.content).startsWith(phraseKey(content)) || phraseKey(content).startsWith(phraseKey(note.content))));
  if (partial) return content.length > partial.content.length
    ? (await db.update(ideaNotes).set({ content }).where(eq(ideaNotes.id, partial.id)).returning())[0] : partial;
  const inserted = await db.insert(ideaNotes).values({ sessionId, sourceKey, kind: cue.kind, content })
    .onConflictDoNothing().returning();
  return inserted[0] ?? (await db.select().from(ideaNotes).where(eq(ideaNotes.sourceKey, sourceKey)).limit(1))[0];
}

/** Scan the saved transcript too, so failed timers or a lost browser cannot discard a note. */
export async function collectTranscriptFeedback(sessionId: number, transcript: TranscriptLine[]) {
  const cues = learnerUtterances(transcript).flatMap(extractIdeaCues);
  const keys = new Set<string>();
  const ids: number[] = [];
  for (const cue of cues) {
    const key = `${cue.kind}:${cue.content}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const note = await saveFeedbackNote(sessionId, cue);
    if (note) ids.push(note.id);
  }
  return ids.length ? getDatabase().select().from(ideaNotes).where(inArray(ideaNotes.id, ids)) : [];
}
