import "server-only";
import { and, asc, count, desc, eq, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { apiUsageEvents, grammarSkills, learnerProfile, practiceSessions, vocabulary } from "@/db/schema";
import type { LearningSnapshot, SessionRecap, TranscriptLine } from "@/lib/learning-types";
import { estimateResponseCostUsd, readResponseTokenUsage } from "@/lib/api-cost";
import { compactTranscript, completedTurnCutoff } from "@/lib/transcript";
import { buildLessonPlan, nextCorrectDayState, selectReviewWords, type NewTarget } from "@/lib/learning-plan";

const DEFAULT_SNAPSHOT: LearningSnapshot = {
  memoryReady: false,
  level: "Ny begynder",
  currentFocus: "Korte hverdagssætninger og tydelig udtale",
  nextLesson: "Hilsner og at præsentere sig selv",
  upcomingLessons: ["Hilsner og at præsentere sig selv"],
  reviewOnlyPlanned: false,
  dueWords: [],
  wordProgress: [],
  knownWordCount: 0,
  masteredWordCount: 0,
  dueWordCount: 0,
  completedSessionCount: 0,
  totalPracticeSeconds: 0,
  estimatedApiCostUsd: 0,
  lastSummary: null,
  lastRecap: null,
};

type ReviewResult = "correct" | "incorrect" | "introduced";

type SessionReview = {
  summary: string;
  level: string;
  currentFocus: string;
  nextLesson: string;
  upcomingLessons: string[];
  nextSessionReviewOnly: boolean;
  newTargets: NewTarget[];
  recap: SessionRecap;
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
    const [profiles, words, totals, mastered, dueTotal, completed, practiceTime, voiceUsage, modelUsage, recentSessions] = await Promise.all([
      db.select().from(learnerProfile).where(eq(learnerProfile.id, 1)).limit(1),
      db
        .select({
          finnish: vocabulary.finnish,
          english: vocabulary.english,
          danish: vocabulary.danish,
          example: vocabulary.example,
          mastery: vocabulary.mastery,
          correctCount: vocabulary.correctCount,
          incorrectCount: vocabulary.incorrectCount,
          correctDayCount: vocabulary.correctDayCount,
          lastFeedback: vocabulary.lastFeedback,
          lastSeenAt: vocabulary.lastSeenAt,
          nextReviewAt: vocabulary.nextReviewAt,
        })
        .from(vocabulary)
        .orderBy(asc(vocabulary.mastery), desc(vocabulary.incorrectCount), asc(vocabulary.nextReviewAt)),
      db.select({ value: count() }).from(vocabulary),
      db.select({ value: count() }).from(vocabulary).where(gte(vocabulary.mastery, 4)),
      db.select({ value: count() }).from(vocabulary)
        .where(or(isNull(vocabulary.nextReviewAt), lte(vocabulary.nextReviewAt, now))),
      db.select({ value: count() }).from(practiceSessions)
        .where(eq(practiceSessions.status, "completed")),
      db.select({ value: sql<string>`COALESCE(SUM(CASE WHEN ${practiceSessions.voiceSeconds} > 0 THEN ${practiceSessions.voiceSeconds} ELSE FLOOR(GREATEST(0, EXTRACT(EPOCH FROM (${practiceSessions.endedAt} - ${practiceSessions.startedAt})))) END), 0)` })
        .from(practiceSessions)
        .where(and(isNotNull(practiceSessions.endedAt), isNotNull(practiceSessions.transcript))),
      db.select({ value: sql<string>`COALESCE(SUM(CASE WHEN ${practiceSessions.voiceSeconds} > 0 THEN ${practiceSessions.voiceSeconds} ELSE GREATEST(0, EXTRACT(EPOCH FROM (${practiceSessions.endedAt} - ${practiceSessions.startedAt}))) END), 0)` })
        .from(practiceSessions)
        .where(isNotNull(practiceSessions.endedAt)),
      db.select({ value: sql<string>`COALESCE(SUM(${apiUsageEvents.estimatedCostUsd}), 0)` }).from(apiUsageEvents),
      db
        .select({ summary: practiceSessions.summary, recap: practiceSessions.recap })
        .from(practiceSessions)
        .where(and(eq(practiceSessions.status, "completed"), isNotNull(practiceSessions.summary)))
        .orderBy(desc(practiceSessions.endedAt))
        .limit(1),
    ]);
    const profile = profiles[0];
    const progress = words.map((word) => ({
      ...word,
      lastSeenAt: word.lastSeenAt?.toISOString() ?? null,
      nextReviewAt: word.nextReviewAt?.toISOString() ?? null,
    }));
    const plan = buildLessonPlan(progress, Array.isArray(profile?.nextTargets) ? profile.nextTargets : [],
      profile?.reviewOnlyNextSession === 1, now);
    const due = selectReviewWords(progress, now).map((word) => ({
      finnish: word.finnish, english: word.english, mastery: word.mastery,
    }));

    return {
      memoryReady: true,
      level: profile?.level ?? DEFAULT_SNAPSHOT.level,
      currentFocus: profile?.currentFocus ?? DEFAULT_SNAPSHOT.currentFocus,
      nextLesson: plan.nextLesson,
      upcomingLessons: plan.upcomingLessons,
      reviewOnlyPlanned: profile?.reviewOnlyNextSession === 1,
      dueWords: due,
      wordProgress: progress,
      knownWordCount: totals[0]?.value ?? 0,
      masteredWordCount: mastered[0]?.value ?? 0,
      dueWordCount: dueTotal[0]?.value ?? 0,
      completedSessionCount: completed[0]?.value ?? 0,
      totalPracticeSeconds: Math.floor(Number(practiceTime[0]?.value ?? 0)),
      estimatedApiCostUsd: Number((Number(voiceUsage[0]?.value ?? 0) * 0.05 / 60 + Number(modelUsage[0]?.value ?? 0)).toFixed(4)),
      lastSummary: recentSessions[0]?.summary ?? null,
      lastRecap: recentSessions[0]?.recap ?? null,
    };
  } catch (error) {
    console.error("Could not load learning memory", error);
    return DEFAULT_SNAPSHOT;
  }
}

export async function getTutorInstructions(): Promise<{ instructions: string; snapshot: LearningSnapshot }> {
  const snapshot = await getLearningSnapshot();
  let recentSummaries: string[] = [];

  if (snapshot.memoryReady) {
    try {
      const sessions = await getDatabase().select({ summary: practiceSessions.summary, recap: practiceSessions.recap }).from(practiceSessions)
          .where(and(eq(practiceSessions.status, "completed"), isNotNull(practiceSessions.summary)))
          .orderBy(desc(practiceSessions.endedAt)).limit(3);
      recentSummaries = sessions.map((row) => [row.summary,
        row.recap?.needsWork.length ? `Needs work: ${row.recap.needsWork.join("; ")}` : "",
      ].filter(Boolean).join(" | ")).filter(Boolean);
    } catch (error) {
      console.error("Could not load familiar words", error);
    }
  }

  const due = snapshot.dueWords.length
    ? snapshot.dueWords.map((word) => `${word.finnish} (${word.english})`).join(", ")
    : "none yet";
  const secure = snapshot.wordProgress.filter((word) => word.mastery >= 4)
    .sort((a, b) => (a.lastSeenAt ?? "").localeCompare(b.lastSeenAt ?? ""))
    .slice(0, 2).map((word) => word.finnish).join(", ") || "none yet";
  const repair = snapshot.wordProgress.filter((word) => word.correctCount === 0 && word.incorrectCount > 0 && word.lastFeedback)
    .sort((a, b) => (a.lastSeenAt ?? "").localeCompare(b.lastSeenAt ?? ""))
    .slice(0, 1).map((word) => `${word.finnish}: ${word.lastFeedback}`).join(" | ") || "none";
  const upcoming = snapshot.upcomingLessons.map((lesson, index) => `${index + 1}. ${lesson}`).join("; ");

  const instructions = `
You are a patient Finnish conversation tutor for one Danish learner.

LANGUAGE AND AUDIO
- The learner may speak Danish or English. Understand both.
- Give explanations and coaching in English unless the learner explicitly asks for Danish.
- Finnish is the target language. Say Finnish examples naturally, clearly, and a little slowly.
- This is hands-free audio, often used while driving. Never ask the learner to read, tap, type, or look at the screen.

TEACHING METHOD
- For a genuinely new visit, begin with a brief English greeting and state today's focus. If prior conversation is supplied for a reconnection, skip the greeting and continue immediately.
- Teach one short Finnish phrase at a time, then pause for the learner to repeat it.
- In every lesson block, practise both directions: give a short Finnish phrase and ask what it means in Danish; also give a Danish meaning and ask the learner to produce the Finnish. Alternate directions instead of making the learner only repeat Finnish.
- When introducing a phrase, give its meaning once. Later, test understanding by asking for the Danish meaning without immediately supplying it.
- In a Finnish-to-Danish comprehension test, say only the Finnish phrase before asking for its Danish meaning. Never give the English translation or gloss immediately before that question; it gives away the answer. Wait for the learner's attempt, then explain or correct. If they ask for help or cannot answer, give the meaning afterward and retest later without a hint.
- Check one or two selected older phrases briefly, then move to the planned new target unless this session is explicitly review-only. The full due backlog is not a script or a quota. Every session should also revisit a few phrases from earlier sessions across the 30 minutes.
- Give more practice to words with low scores or repeated errors. Reuse high-score words only as occasional spaced review or sentence building.
- Unless the learner has asked for review only, introduce one or two genuinely new, connected words or a useful phrase after each short review burst. In a 30-minute session, aim for several small new targets, not a long loop of known sentences. Revisit the new target later in a different context. Do not overwhelm with a large vocabulary list.
- Correct gently: if you clearly heard the learner's Finnish attempt, quote their exact attempt first ("You said: …"), then say the corrected Finnish slowly ("A natural form is: …"), and explain the specific difference in one short English sentence. Do not invent an exact quote from uncertain speech recognition; ask for a repeat instead. If the attempt was already acceptable, say so rather than manufacturing an error.
- After an attempt, say briefly whether the word was right or what you corrected. Only comment on pronunciation when you can clearly hear a specific issue; otherwise ask for another attempt.
- Recycle older words in new short sentences. Do not randomly change topic.
- If speech recognition seems uncertain, ask the learner to repeat instead of confidently marking it wrong.
- If the learner says "note til senere" or describes an app idea/correction naturally, continue listening and let the app save it; do not require a special phrase or ask them to repeat it. Do not claim it was saved unless the app confirms it.
- A note or app-feedback comment is not a request to stop the lesson. Only end when the learner clearly asks to stop the conversation (for example, "stop samtalen", "jeg er færdig", "lad os stoppe nu"). If unclear, ask a brief clarification while keeping the lesson open.
- End naturally when the learner asks to stop; the application saves the transcript and updates the plan afterward.

SESSION PACING AND PROGRESSION
- The learner's goal is about 30 minutes of Finnish practice per session. Treat 30 minutes as the target, not a hard limit: do not announce that the lesson is finished, suggest pausing, or start wrapping up before 30 minutes unless the learner asks to stop or pause. Keep the lesson moving continuously until the learner clearly asks to stop. The learner may stop earlier if they choose; at around 30 minutes, acknowledge the target and ask whether they want to stop or continue.
- Organize a 30-minute session into roughly five or six connected lesson blocks of 4–6 minutes, and keep transitions flowing without waiting for the learner to request each next block.
- A block should contain a small number of targeted retrieval questions, balanced Finnish-to-Danish comprehension and Danish-to-Finnish production, and a short varied exchange. By default add one connected new target after a brief retrieval burst, then use it in two contexts before moving on. If the learner explicitly wants review only, use fresh combinations of known material instead.
- Do not limit cumulative review to one or two questions for the entire session. Retrieve several phrases from different earlier sessions across the full 30-minute practice, especially near the end, while keeping each individual review burst short.
- If the learner asks for a brief review of earlier material, do that for a few prompts and then return to a connected new target. If they explicitly ask for a review-only session, practise only what has already been learned, or say not to add new words, stop introducing new vocabulary and grammar for the rest of that session; do not sneak in a “small new twist.”
- A review-only request overrides the default plan for THIS session. Do not assume it applies to a future session unless the learner explicitly asks for that.
- Advance after a phrase is correct in a couple of varied contexts. Avoid asking for the same sentence to be repeated several times after a clear success; revisit it later in a different prompt or translation direction.
- When asking a retrieval question, do not give the full answer as a "hint". Start with no hint, then one partial cue only if needed.
- If the learner says the material is repetitive or asks for something new, acknowledge once and switch to a genuinely different target. If they ask to review old material instead, do that instead of introducing a new target.
- If the learner explicitly asks for new things after a long review, switch now to a genuinely new, connected phrase or concept. Do at most one brief review burst, then spend the next blocks on the new target; do not drift back into a long sequence of familiar prompts.
- Do not ask "want to continue?" at the end of each block; just make a natural transition and teach the next item. The learner should not need to repeatedly say "fortsæt" to keep a 30-minute session going.
- After a few successful attempts, briefly acknowledge progress and immediately begin the next logical block. Do not end the lesson or wait for the application.
- If the learner says "next", "continue", "go on", "næste", or asks for the next lesson, move on immediately and start teaching. Do not merely describe what the next lesson will contain.
- Treat the planned next lesson below as the starting point, not as the only lesson allowed in this session.
- Choose logical continuations yourself. A useful sequence is: brief retrieval from older sessions, a planned target or review set, comprehension and production in both directions, then a mixed review of older phrases before ending. Continue with further connected blocks if time remains.
- Never say that you are thinking, preparing, loading, checking the database, or waiting for a lesson plan. If planning is delayed, keep the learner engaged with a review question and then continue.
- The application may send a progress checkpoint while you speak. Use it to avoid repeating completed drills and to move to the next connected block when the learner is ready.
- A checkpoint is background work, not a pause or end to the voice conversation. Keep listening and teaching; never ask the learner to restart or press a button.
- If the voice connection resumes after an interruption, continue from the supplied recent conversation. Do not greet, reintroduce the lesson, or ask already answered questions.

FINNISH ACCURACY ANCHORS
- For "Mitä kuuluu?", a simple model answer is "Ihan hyvää, kiitos." For "Miten menee?", "Ihan hyvin, kiitos." Never teach "Olen hyvää, kiitos."
- "Olen töissä" means "I am at work"; "menen töihin" means "I am going to work". "Menen kotiin tänään" is also a valid activity/plan in answer to "Mitä teet tänään?"; do not mark a grammatically valid answer wrong merely because you expected a different example.
- Do not treat imperfect speech-to-text spelling alone as evidence of a pronunciation error.
- When asked about kun/sitten versus jos/niin, teach the meaning contrast, not a memorized word-pair rule: kun usually introduces a time/when clause, jos a condition/if clause; sitten commonly marks a later step or "then" in time; niin may mark the start of the main clause after either jos or kun, especially in speech, and is often optional. Do not claim niin is required after jos or forbidden after kun, or that sitten and niin are always interchangeable. Give one short contrastive example at the learner's level, answer the learner's "why" first, then return to practice.
- More generally, when the learner asks why a form or alternative was used, pause the drill, explain the actual meaning/grammar distinction with a minimal pair, check understanding once, then continue. Do not repeat the same unexplained answer.

LEARNER MEMORY
- Approximate level: ${snapshot.level}
- Current focus: ${snapshot.currentFocus}
- Planned next lesson: ${snapshot.nextLesson}
- Review-only explicitly planned for this session: ${snapshot.reviewOnlyPlanned ? "yes — do not add new material" : "no — progress after brief review"}
- Provisional upcoming lesson blocks: ${upcoming}
- Selected review targets for this session (at most five, not the whole backlog): ${due}
- Secure examples (optional quick maintenance, no drilling): ${secure}
- One earlier learner error to revisit with a corrected form (NEVER present the error itself as model Finnish): ${repair}
- Recent sessions, newest first: ${recentSummaries.join(" | ") || "No completed session recorded yet."}

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

export async function checkpointPracticeSession(id: number, fragments: TranscriptLine[]): Promise<{
  learning: LearningSnapshot;
  progressCursor: number;
  correctWords: string[];
  difficultWords: string[];
}> {
  if (!isDatabaseConfigured()) throw new Error("Læringshukommelsen mangler en databaseforbindelse.");
  await ensureDatabaseSchema();
  const db = getDatabase();
  const rows = await db.select({ status: practiceSessions.status, progressCursor: practiceSessions.progressCursor })
    .from(practiceSessions).where(eq(practiceSessions.id, id)).limit(1);
  const session = rows[0];
  if (!session) throw new Error("Samtalen findes ikke.");
  const noChange = async () => ({
    learning: await getLearningSnapshot(),
    progressCursor: session.progressCursor,
    correctWords: [],
    difficultWords: [],
  });
  if (session.status !== "started" || fragments.length <= session.progressCursor) return noChange();

  const fullTranscript = compactTranscript(fragments);
  const processUntil = completedTurnCutoff(fragments);
  const freshTranscript = compactTranscript(fragments.slice(session.progressCursor, processUntil));
  await db.update(practiceSessions).set({ transcript: fullTranscript })
    .where(and(eq(practiceSessions.id, id), eq(practiceSessions.status, "started")));
  if (!freshTranscript.length) return noChange();

  const review = await analyseTranscript(fullTranscript.slice(-40), await getLearningSnapshot(), freshTranscript, id);
  let applied = false;
  await db.transaction(async (tx) => {
    const locked = await tx.select({ progressCursor: practiceSessions.progressCursor, status: practiceSessions.status })
      .from(practiceSessions).where(eq(practiceSessions.id, id)).for("update").limit(1);
    if (locked[0]?.status !== "started" || locked[0]?.progressCursor !== session.progressCursor) return;
    await applyReview(review, false, tx);
    await tx.update(practiceSessions).set({ progressCursor: processUntil }).where(eq(practiceSessions.id, id));
    applied = true;
  });
  return {
    learning: await getLearningSnapshot(),
    progressCursor: applied ? processUntil : session.progressCursor,
    correctWords: applied ? review.words.filter((word) => word.result === "correct").map((word) => word.finnish).slice(0, 8) : [],
    difficultWords: applied ? review.words.filter((word) => word.result === "incorrect").map((word) => word.finnish).slice(0, 8) : [],
  };
}

export async function completePracticeSession(id: number, fragments: TranscriptLine[]): Promise<LearningSnapshot> {
  if (!isDatabaseConfigured()) throw new Error("Læringshukommelsen mangler en databaseforbindelse.");
  if (!fragments.some((line) => line.text.trim())) throw new Error("Samtalen indeholdt ikke noget transkript at gemme.");

  await ensureDatabaseSchema();
  const db = getDatabase();
  const rows = await db.select({ status: practiceSessions.status, progressCursor: practiceSessions.progressCursor })
    .from(practiceSessions).where(eq(practiceSessions.id, id)).limit(1);
  const session = rows[0];
  if (!session) throw new Error("Samtalen findes ikke.");
  if (session.status === "completed") return getLearningSnapshot();
  const cleanTranscript = compactTranscript(fragments);
  const freshTranscript = compactTranscript(fragments.slice(session.progressCursor));

  await db
    .update(practiceSessions)
    .set({ transcript: cleanTranscript, endedAt: new Date(), status: "analysing" })
    .where(eq(practiceSessions.id, id));

  try {
    const review = await analyseTranscript(cleanTranscript, await getLearningSnapshot(), freshTranscript, id);
    await db.transaction(async (tx) => {
      await applyReview(review, true, tx);
      await tx.update(practiceSessions)
        .set({ summary: review.summary, recap: review.recap, endedAt: new Date(), status: "completed", progressCursor: fragments.length })
        .where(eq(practiceSessions.id, id));
    });
    return getLearningSnapshot();
  } catch (error) {
    await db
      .update(practiceSessions)
      .set({ endedAt: new Date(), status: "analysis_failed" })
      .where(eq(practiceSessions.id, id));
    throw error;
  }
}

async function storeResponseUsage(sessionId: number, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== "object") return;
  const response = payload as { id?: unknown; model?: unknown; usage?: unknown };
  if (typeof response.id !== "string" || typeof response.model !== "string") return;
  const usage = readResponseTokenUsage(response.usage);
  if (!usage) return;
  const estimatedCostUsd = estimateResponseCostUsd(response.model, usage);
  if (estimatedCostUsd === null) return;
  try {
    await getDatabase().insert(apiUsageEvents).values({
      sessionId,
      responseId: response.id,
      model: response.model,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: estimatedCostUsd.toFixed(10),
    }).onConflictDoNothing();
  } catch (error) {
    console.error("Could not save response API usage", error);
  }
}

async function analyseTranscript(transcript: TranscriptLine[], memory: LearningSnapshot, scoringTranscript = transcript, sessionId?: number): Promise<SessionReview> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY mangler på serveren.");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-luna",
      reasoning: { effort: "low" },
      store: false,
      max_output_tokens: 2500,
      input: [
        {
          role: "system",
          content:
            `You evaluate a Finnish tutoring transcript. Transcription can be imperfect, so only mark an item correct or incorrect when the learner's attempt and tutor feedback clearly support it. Otherwise use introduced. If a word was attempted repeatedly, use the most recent clear attempt. A tutor correction may itself be wrong; do not penalize a valid learner answer just because the tutor expected a different scripted answer.
Extract words and grammar results only from scoringTranscript; transcript and priorLearning provide context for summary and planning, not evidence of a new scored attempt. Ignore app-feedback notes as lesson material. If scoringTranscript is empty, return empty words and grammar arrays. One result per canonical word or SHORT valid Finnish phrase per segment, not every full sentence or inflected restatement. If the learner made a mistake, use the corrected VALID Finnish form as the key and result=incorrect; put the learner's mistake in feedback. Never store an ungrammatical learner attempt as a model phrase. If a word was attempted repeatedly, use the most recent clear attempt. A tutor correction may itself be wrong; do not penalize a valid learner answer just because the tutor expected a different scripted answer. Mention pronunciation only if the tutor explicitly corrected pronunciation; do not infer accent from transcript spelling. Use stable lowercase ASCII keys for grammar topics.
Write the summary and recap in concise English. Recap.progress must name up to 3 concrete achievements supported by the transcript; recap.needsWork names up to 3 specific remaining difficulties; recap.nextStep states one actionable next move. Empty arrays are okay; do not invent progress or claim a word is mastered after one success.
For the NEXT session, propose two genuinely new connected Finnish targets with English meanings in newTargets, absent from priorLearning. Prefer a different everyday situation if work/home/greetings were repeated. Do not propose existing phrases with trivial punctuation or inflection changes as new. The lesson should mix short older-phrase retrieval, Finnish-to-Danish comprehension, Danish-to-Finnish production, and new material. Do not build all blocks around mastered sentences.
Set nextSessionReviewOnly=true ONLY if the learner clearly requested the NEXT session be review-only or contain no new material. A request for review during this session, or a general comment that some days can be review-only, does NOT carry over. If true, return no newTargets. The learner's preference overrides default progression.
Never plan a full drill of phrases the learner already used successfully. The level may be A0, A1, A2, B1, B2, C1, or C2 with a short qualifier. Return structured JSON only.`,
        },
        {
          role: "system",
          content: "Planning preference: introduce new connected targets next session by default. A review-only request for the current session does not persist automatically. Do not build three blocks around previously mastered phrases. If they asked why two Finnish forms differ, include one short contrastive explanation before practice.",
        },
        {
          role: "user",
          content: JSON.stringify({
            priorLearning: {
              level: memory.level,
              currentFocus: memory.currentFocus,
              upcomingLessons: memory.upcomingLessons,
              dueWords: memory.dueWords.map((word) => ({ finnish: word.finnish, english: word.english })),
              weakestWords: memory.wordProgress.slice(0, 10).map((word) => ({
                finnish: word.finnish,
                mastery: word.mastery,
                incorrectCount: word.incorrectCount,
              })),
              knownFinnish: memory.wordProgress.map((word) => word.finnish),
            },
            transcript,
            scoringTranscript,
          }),
        },
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
              upcomingLessons: { type: "array", items: { type: "string" } },
              nextSessionReviewOnly: { type: "boolean" },
              newTargets: {
                type: "array", items: { type: "object", properties: {
                  finnish: { type: "string" }, english: { type: "string" },
                }, required: ["finnish", "english"], additionalProperties: false },
              },
              recap: { type: "object", properties: {
                progress: { type: "array", items: { type: "string" } },
                needsWork: { type: "array", items: { type: "string" } },
                nextStep: { type: "string" },
              }, required: ["progress", "needsWork", "nextStep"], additionalProperties: false },
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
            required: ["summary", "level", "currentFocus", "nextLesson", "upcomingLessons", "nextSessionReviewOnly", "newTargets", "recap", "words", "grammar"],
            additionalProperties: false,
          },
        },
      },
    }),
    cache: "no-store",
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(payload));
  if (sessionId) await storeResponseUsage(sessionId, payload);
  const output = responseText(payload);
  if (!output) throw new Error("OpenAI returnerede ingen sessionsanalyse.");
  return JSON.parse(output) as SessionReview;
}

async function applyReview(
  review: SessionReview,
  updateProfile: boolean,
  db: Parameters<Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]>[0],
): Promise<void> {
  const now = new Date();
  const upcomingLessons = (Array.isArray(review.upcomingLessons) ? review.upcomingLessons : [])
    .filter((lesson): lesson is string => typeof lesson === "string")
    .map((lesson) => lesson.trim())
    .filter(Boolean)
    .slice(0, 3);
  const nextLesson = upcomingLessons[0] || review.nextLesson.trim() || DEFAULT_SNAPSHOT.nextLesson;
  if (!upcomingLessons.length) upcomingLessons.push(nextLesson);

  if (updateProfile) await db
    .insert(learnerProfile)
    .values({
      id: 1,
      level: review.level,
      currentFocus: review.currentFocus,
      nextLesson,
      upcomingLessons,
      nextTargets: review.nextSessionReviewOnly ? [] : review.newTargets.slice(0, 2),
      reviewOnlyNextSession: review.nextSessionReviewOnly ? 1 : 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: learnerProfile.id,
      set: {
        level: review.level,
        currentFocus: review.currentFocus,
        nextLesson,
        upcomingLessons,
        nextTargets: review.nextSessionReviewOnly ? [] : review.newTargets.slice(0, 2),
        reviewOnlyNextSession: review.nextSessionReviewOnly ? 1 : 0,
        updatedAt: now,
      },
    });

  for (const word of uniqueBy(review.words, (item) => normalise(item.finnish))) {
    const finnish = normalise(word.finnish);
    if (!finnish) continue;
    const existing = await db.select().from(vocabulary).where(eq(vocabulary.finnish, finnish)).for("update").limit(1);
    const current = existing[0];
    const scores = nextScores(current?.mastery ?? 0, current?.correctCount ?? 0, current?.incorrectCount ?? 0, word.result);
    const dayState = nextCorrectDayState(current?.correctDayCount ?? 0, current?.lastCorrectDay ?? null, word.result === "correct", now);
    const values = {
      finnish,
      english: word.english.trim(),
      danish: word.danish.trim() || null,
      example: word.example.trim() || null,
      mastery: scores.mastery,
      correctCount: scores.correctCount,
      incorrectCount: scores.incorrectCount,
      ...dayState,
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
