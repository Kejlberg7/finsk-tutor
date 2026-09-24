import "server-only";
import { and, asc, count, desc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { grammarSkills, learnerProfile, practiceSessions, vocabulary } from "@/db/schema";
import type { LearningSnapshot, TranscriptLine } from "@/lib/learning-types";

const DEFAULT_SNAPSHOT: LearningSnapshot = {
  memoryReady: false,
  level: "Ny begynder",
  currentFocus: "Korte hverdagssætninger og tydelig udtale",
  nextLesson: "Hilsner og at præsentere sig selv",
  dueWords: [],
  wordProgress: [],
  knownWordCount: 0,
  lastSummary: null,
};

type ReviewResult = "correct" | "incorrect" | "introduced";

type SessionReview = {
  summary: string;
  level: string;
  currentFocus: string;
  nextLesson: string;
  words: Array<{
    finnish: string;
    english: string;
    danish: string;
    example: string;
    result: ReviewResult;
    feedback: string;
  }>;
  grammar: Array<{
    key: string;
    name: string;
    result: ReviewResult;
  }>;
};

export async function getLearningSnapshot(): Promise<LearningSnapshot> {
  if (!isDatabaseConfigured()) return DEFAULT_SNAPSHOT;

  try {
    await ensureDatabaseSchema();
    const db = getDatabase();
    const now = new Date();
    const [profiles, due, words, totals, recentSessions] = await Promise.all([
      db.select().from(learnerProfile).where(eq(learnerProfile.id, 1)).limit(1),
      db
        .select({ finnish: vocabulary.finnish, english: vocabulary.english, mastery: vocabulary.mastery })
        .from(vocabulary)
        .where(or(isNull(vocabulary.nextReviewAt), lte(vocabulary.nextReviewAt, now)))
        .orderBy(asc(vocabulary.nextReviewAt))
        .limit(8),
      db
        .select({
          finnish: vocabulary.finnish,
          english: vocabulary.english,
          mastery: vocabulary.mastery,
          correctCount: vocabulary.correctCount,
          incorrectCount: vocabulary.incorrectCount,
          lastFeedback: vocabulary.lastFeedback,
          nextReviewAt: vocabulary.nextReviewAt,
        })
        .from(vocabulary)
        .orderBy(asc(vocabulary.mastery), desc(vocabulary.incorrectCount), asc(vocabulary.nextReviewAt))
        .limit(100),
      db.select({ value: count() }).from(vocabulary),
      db
        .select({ summary: practiceSessions.summary })
        .from(practiceSessions)
        .where(and(eq(practiceSessions.status, "completed"), isNotNull(practiceSessions.summary)))
        .orderBy(desc(practiceSessions.endedAt))
        .limit(1),
    ]);
    const profile = profiles[0];

    return {
      memoryReady: true,
      level: profile?.level ?? DEFAULT_SNAPSHOT.level,
      currentFocus: profile?.currentFocus ?? DEFAULT_SNAPSHOT.currentFocus,
      nextLesson: profile?.nextLesson ?? DEFAULT_SNAPSHOT.nextLesson,
      dueWords: due,
      wordProgress: words.map((word) => ({
        ...word,
        nextReviewAt: word.nextReviewAt?.toISOString() ?? null,
      })),
      knownWordCount: totals[0]?.value ?? 0,
      lastSummary: recentSessions[0]?.summary ?? null,
    };
  } catch (error) {
    console.error("Could not load learning memory", error);
    return DEFAULT_SNAPSHOT;
  }
}

export async function getTutorInstructions(): Promise<{ instructions: string; snapshot: LearningSnapshot }> {
  const snapshot = await getLearningSnapshot();
  let familiarWords: Array<{ finnish: string; english: string; mastery: number }> = [];

  if (snapshot.memoryReady) {
    try {
      familiarWords = await getDatabase()
        .select({ finnish: vocabulary.finnish, english: vocabulary.english, mastery: vocabulary.mastery })
        .from(vocabulary)
        .orderBy(desc(vocabulary.mastery), desc(vocabulary.lastSeenAt))
        .limit(15);
    } catch (error) {
      console.error("Could not load familiar words", error);
    }
  }

  const due = snapshot.dueWords.length
    ? snapshot.dueWords.map((word) => `${word.finnish} (${word.english})`).join(", ")
    : "none yet";
  const familiar = familiarWords.length
    ? familiarWords.map((word) => `${word.finnish} (${word.english}, score ${word.mastery}/5)`).join(", ")
    : "none recorded yet";

  const instructions = `
You are a patient Finnish conversation tutor for one Danish learner.

LANGUAGE AND AUDIO
- The learner may speak Danish or English. Understand both.
- Give explanations and coaching in English unless the learner explicitly asks for Danish.
- Finnish is the target language. Say Finnish examples naturally, clearly, and a little slowly.
- This is hands-free audio, often used while driving. Never ask the learner to read, tap, type, or look at the screen.

TEACHING METHOD
- Begin with a brief English greeting and state today's focus.
- Teach one short Finnish phrase at a time, then pause for the learner to repeat it.
- Review due words before adding new material.
- Give more practice to words with low scores or repeated errors. Reuse high-score words only as occasional spaced review or sentence building.
- Introduce at most three new Finnish words in each lesson block, not in the whole session.
- Correct gently: acknowledge the attempt, say the corrected Finnish slowly, then give one short English explanation.
- After an attempt, say briefly whether the word was right or what you corrected. Only comment on pronunciation when you can clearly hear a specific issue; otherwise ask for another attempt.
- Recycle older words in new short sentences. Do not randomly change topic.
- If speech recognition seems uncertain, ask the learner to repeat instead of confidently marking it wrong.
- End naturally when the learner asks to stop; the application saves the transcript and updates the plan afterward.

SESSION PACING AND PROGRESSION
- The learner normally practises for 20–30 minutes. Keep teaching continuously until the learner asks to stop.
- Organize the session into connected lesson blocks of roughly 4–6 minutes.
- A block should normally contain: a quick review, one small new concept with up to three new words, repetition, and a short question or mini-dialogue.
- After a few successful attempts, briefly acknowledge progress and immediately begin the next logical block. Do not end the lesson or wait for the application.
- If the learner says "next", "continue", "go on", "næste", or asks for the next lesson, move on immediately and start teaching. Do not merely describe what the next lesson will contain.
- Treat the planned next lesson below as the starting point, not as the only lesson allowed in this session.
- Choose logical continuations yourself. A useful sequence is: core phrases, a variation, question-and-answer, mini-dialogue, then mixed review. Continue with further connected blocks if time remains.
- Never say that you are thinking, preparing, loading, checking the database, or waiting for a lesson plan. If planning is delayed, keep the learner engaged with a review question and then continue.

LEARNER MEMORY
- Approximate level: ${snapshot.level}
- Current focus: ${snapshot.currentFocus}
- Planned next lesson: ${snapshot.nextLesson}
- Due for review: ${due}
- Familiar vocabulary: ${familiar}
- Last session: ${snapshot.lastSummary ?? "No completed session recorded yet."}

Use this memory as guidance, not as a script. Do not tell the learner about database scores or internal tracking.
`;

  return { instructions, snapshot };
}

export async function beginPracticeSession(): Promise<number | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    await ensureDatabaseSchema();
    const rows = await getDatabase().insert(practiceSessions).values({ status: "started" }).returning({ id: practiceSessions.id });
    return rows[0]?.id ?? null;
  } catch (error) {
    console.error("Could not start practice session", error);
    return null;
  }
}

export async function attachLiveSessionId(id: number | null, liveSessionId: string | null): Promise<void> {
  if (!id || !liveSessionId || !isDatabaseConfigured()) return;
  try {
    await ensureDatabaseSchema();
    await getDatabase().update(practiceSessions).set({ liveSessionId }).where(eq(practiceSessions.id, id));
  } catch (error) {
    console.error("Could not attach Live session id", error);
  }
}

export async function completePracticeSession(id: number, transcript: TranscriptLine[]): Promise<LearningSnapshot> {
  if (!isDatabaseConfigured()) throw new Error("Læringshukommelsen mangler en databaseforbindelse.");
  if (!transcript.some((line) => line.text.trim())) throw new Error("Samtalen indeholdt ikke noget transkript at gemme.");

  await ensureDatabaseSchema();

  const cleanTranscript = transcript
    .map((line) => ({ speaker: line.speaker, text: line.text.trim() }))
    .filter((line) => line.text)
    .slice(-240);
  const db = getDatabase();

  await db
    .update(practiceSessions)
    .set({ transcript: cleanTranscript, endedAt: new Date(), status: "analysing" })
    .where(eq(practiceSessions.id, id));

  try {
    const review = await analyseTranscript(cleanTranscript);
    await applyReview(review);
    await db
      .update(practiceSessions)
      .set({ summary: review.summary, endedAt: new Date(), status: "completed" })
      .where(eq(practiceSessions.id, id));
    return getLearningSnapshot();
  } catch (error) {
    await db
      .update(practiceSessions)
      .set({ endedAt: new Date(), status: "analysis_failed" })
      .where(eq(practiceSessions.id, id));
    throw error;
  }
}

async function analyseTranscript(transcript: TranscriptLine[]): Promise<SessionReview> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY mangler på serveren.");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-luna",
      reasoning: { effort: "low" },
      store: false,
      max_output_tokens: 1800,
      input: [
        {
          role: "system",
          content:
            "You evaluate a Finnish tutoring transcript. Transcription can be imperfect, so only mark an item correct or incorrect when the learner's attempt and tutor feedback clearly support it. Otherwise use introduced. If a word was attempted repeatedly, use the most recent clear attempt. Extract only Finnish words or short phrases actually taught, attempted, or reviewed. For each word, feedback is a brief specific correction explicitly supported by the tutor's words, or an empty string. Mention pronunciation only if the tutor explicitly corrected pronunciation; do not infer accent from transcript spelling. Use stable lowercase ASCII keys for grammar topics. Write the summary, focus, lesson, and meanings in concise English. The level may be A0, A1, A2, B1, B2, C1, or C2 with a short qualifier. Return structured JSON only.",
        },
        { role: "user", content: JSON.stringify(transcript) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "finnish_tutoring_review",
          strict: true,
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              level: { type: "string" },
              currentFocus: { type: "string" },
              nextLesson: { type: "string" },
              words: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    finnish: { type: "string" },
                    english: { type: "string" },
                    danish: { type: "string" },
                    example: { type: "string" },
                    result: { type: "string", enum: ["correct", "incorrect", "introduced"] },
                    feedback: { type: "string" },
                  },
                  required: ["finnish", "english", "danish", "example", "result", "feedback"],
                  additionalProperties: false,
                },
              },
              grammar: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    name: { type: "string" },
                    result: { type: "string", enum: ["correct", "incorrect", "introduced"] },
                  },
                  required: ["key", "name", "result"],
                  additionalProperties: false,
                },
              },
            },
            required: ["summary", "level", "currentFocus", "nextLesson", "words", "grammar"],
            additionalProperties: false,
          },
        },
      },
    }),
    cache: "no-store",
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(payload));
  const output = responseText(payload);
  if (!output) throw new Error("OpenAI returnerede ingen sessionsanalyse.");
  return JSON.parse(output) as SessionReview;
}

async function applyReview(review: SessionReview): Promise<void> {
  const db = getDatabase();
  const now = new Date();

  await db
    .insert(learnerProfile)
    .values({
      id: 1,
      level: review.level,
      currentFocus: review.currentFocus,
      nextLesson: review.nextLesson,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: learnerProfile.id,
      set: {
        level: review.level,
        currentFocus: review.currentFocus,
        nextLesson: review.nextLesson,
        updatedAt: now,
      },
    });

  for (const word of uniqueBy(review.words, (item) => normalise(item.finnish))) {
    const finnish = normalise(word.finnish);
    if (!finnish) continue;
    const existing = await db.select().from(vocabulary).where(eq(vocabulary.finnish, finnish)).limit(1);
    const current = existing[0];
    const scores = nextScores(current?.mastery ?? 0, current?.correctCount ?? 0, current?.incorrectCount ?? 0, word.result);
    const values = {
      finnish,
      english: word.english.trim(),
      danish: word.danish.trim() || null,
      example: word.example.trim() || null,
      mastery: scores.mastery,
      correctCount: scores.correctCount,
      incorrectCount: scores.incorrectCount,
      lastFeedback: word.result === "incorrect" && word.feedback.trim()
        ? word.feedback.trim().slice(0, 240)
        : current?.lastFeedback ?? null,
      lastSeenAt: now,
      nextReviewAt: nextReviewDate(scores.mastery, word.result, now),
    };
    await db.insert(vocabulary).values(values).onConflictDoUpdate({ target: vocabulary.finnish, set: values });
  }

  for (const skill of uniqueBy(review.grammar, (item) => normaliseKey(item.key))) {
    const key = normaliseKey(skill.key);
    if (!key) continue;
    const existing = await db.select().from(grammarSkills).where(eq(grammarSkills.key, key)).limit(1);
    const current = existing[0];
    const scores = nextScores(current?.mastery ?? 0, current?.correctCount ?? 0, current?.incorrectCount ?? 0, skill.result);
    const values = {
      key,
      name: skill.name.trim(),
      mastery: scores.mastery,
      correctCount: scores.correctCount,
      incorrectCount: scores.incorrectCount,
      lastSeenAt: now,
      nextReviewAt: nextReviewDate(scores.mastery, skill.result, now),
    };
    await db.insert(grammarSkills).values(values).onConflictDoUpdate({ target: grammarSkills.key, set: values });
  }
}

function nextScores(mastery: number, correctCount: number, incorrectCount: number, result: ReviewResult) {
  if (result === "correct") {
    return { mastery: Math.min(5, mastery + 1), correctCount: correctCount + 1, incorrectCount };
  }
  if (result === "incorrect") {
    return { mastery: Math.max(0, mastery - 1), correctCount, incorrectCount: incorrectCount + 1 };
  }
  return { mastery, correctCount, incorrectCount };
}

function nextReviewDate(mastery: number, result: ReviewResult, from: Date): Date {
  const days = result === "correct" ? [1, 2, 4, 7, 14, 30][mastery] ?? 30 : 1;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function normalise(value: string): string {
  return value.trim().toLocaleLowerCase("fi-FI").replace(/\s+/g, " ");
}

function normaliseKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function responseText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const direct = (payload as { output_text?: unknown }).output_text;
  if (typeof direct === "string") return direct;
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

function apiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "OpenAI kunne ikke analysere samtalen.";
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "OpenAI kunne ikke analysere samtalen.";
}
