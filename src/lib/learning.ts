import "server-only";
import { and, asc, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { ensureDatabaseSchema, getDatabase, isDatabaseConfigured } from "@/db";
import { apiUsageEvents, expressionAttempts, grammarSkills, learnerProfile, practiceItems, practiceSessions, vocabulary } from "@/db/schema";
import { buildLiveInstructions, buildTutorBackendInstructions } from "./tutor-prompts";
import { collectTranscriptFeedback, saveFeedbackNote } from "./feedback-notes";
import type { LearningSnapshot, SessionRecap, TranscriptLine } from "@/lib/learning-types";
import { estimateResponseCostUsd, readResponseTokenUsage } from "@/lib/api-cost";
import { compactTranscript, completedTurnCutoff, learnerUtterances, scoringTurns } from "@/lib/transcript";
import { extractIdeaCues } from "./idea-cue";
import { phraseKey } from "./practice-history";
import { buildLessonPlan, isDue, selectReviewWords, type NewTarget } from "@/lib/learning-plan";
import { expressionKey, expressionStageLabel, isStrong, projectExpressions, verifiedAttempts, type ExpressionAttempt, type ProposedAttempt } from "./expression-progress";
import { a1OralLevel, a1TestEligible, determineA1Outcome, verifyA1Evidence, type A1Assessment, type A1Checks, type SessionKind } from "@/lib/a1-test";
import { recordServerDiagnostic } from "./session-diagnostics-server";

const A1_TEST_INSTRUCTIONS = `
You are conducting Finsk Tutor's internal ORAL A1 check for one Danish learner. This is not an official CEFR exam and does not assess reading or writing. The learner is often driving: all instructions and feedback must be spoken, never ask them to read, tap or look at a screen. Explain the tasks briefly in English; say Finnish naturally and slowly. The learner may ask for a slower repeat, which is allowed. All coaching must be in English; the learner can answer in Danish.
Backchannel policy: Use very few listening sounds. Wait for the entire learner answer before evaluating it.
Interruption policy: Yield to the learner and allow pauses and self-corrections.

Start by saying in English: "This is a short oral A1 check, not an official certificate. I'll ask a few everyday questions in Finnish. I'll save feedback when we finish." Then administer four DISTINCT tasks, one prompt at a time, allowing the learner to answer before continuing:
1. Ask the learner to introduce themselves in Finnish: name, where they live, and one simple thing they do or like. Do not provide a model answer.
2. Ask at least two short Finnish-only questions about familiar personal or daily topics. Do not translate or reveal the answer before the learner responds. An English explanation of the question after their attempt is acceptable; it must not be counted as independent comprehension.
3. Have a two-way exchange: ask and answer simple personal questions in Finnish. The learner must ask at least one question of their own in Finnish, not just repeat yours.
4. Do a simple everyday role-play, such as ordering a drink or asking for a price/direction. The learner must communicate a need and respond to one follow-up in Finnish.

Do not teach, drill, correct, give answer hints, or announce scores during the test. If a prompt is unclear, repeat it slowly once or rephrase in Finnish; do not translate it before the attempt. If the learner asks to stop, honor it. Take roughly 10–15 minutes, but let them answer at their pace. When all four tasks have been attempted, say in English: "The test questions are complete. Please say 'stop samtalen' when you want the app to save your result." If they continue talking, remain in test mode and ask a fresh simple variation; do not start a normal lesson. Never claim they have passed or that this is an official certificate. The app evaluates and saves the transcript afterward.
`;

const DEFAULT_SNAPSHOT: LearningSnapshot = {
  memoryReady: false,
  level: "A0 · på vej mod A1",
  currentFocus: "Korte hverdagssætninger og tydelig udtale",
  nextLesson: "Hilsner og at præsentere sig selv",
  upcomingLessons: ["Hilsner og at præsentere sig selv"],
  reviewOnlyPlanned: false,
  dueWords: [],
  wordProgress: [],
  knownWordCount: 0,
  masteredWordCount: 0,
  a1Test: { eligible: false, passes: 0, latest: null, latestAt: null },
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
  feedbackNotes: Array<{ kind: "idea" | "correction"; content: string; evidence: string }>;
  recap: SessionRecap;
  words: Array<{
    finnish: string;
    english: string;
    danish: string;
    example: string;
    result: ReviewResult;
    independent: boolean;
    evidence: string;
    feedback: string;
    attempts: Array<ProposedAttempt & { offsetMs?: number }>;
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
    const [profiles, words, attempts, completed, practiceTime, voiceUsage, modelUsage, recentSessions, a1Tests] = await Promise.all([
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
      db.select().from(expressionAttempts),
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
      db.select({ assessment: practiceSessions.a1Assessment, endedAt: practiceSessions.endedAt })
        .from(practiceSessions)
        .where(and(eq(practiceSessions.kind, "a1_test"), eq(practiceSessions.status, "completed"), isNotNull(practiceSessions.a1Assessment)))
        .orderBy(desc(practiceSessions.endedAt)),
    ]);
    const profile = profiles[0];
    const progress = projectExpressions(words.map((word) => ({
      ...word,
      lastSeenAt: word.lastSeenAt?.toISOString() ?? null,
      nextReviewAt: word.nextReviewAt?.toISOString() ?? null,
    })), attempts.map((a) => ({ ...a, mode: a.mode as ExpressionAttempt["mode"], result: a.result as ExpressionAttempt["result"],
      independent: a.independent === 1, occurredAt: a.occurredAt.toISOString() })));
    const plan = buildLessonPlan(progress, Array.isArray(profile?.nextTargets) ? profile.nextTargets : [],
      profile?.reviewOnlyNextSession === 1, now);
    const due = selectReviewWords(progress, now).map((word) => ({
      finnish: word.finnish, english: word.english, mastery: word.mastery, status: expressionStageLabel(word),
    }));

    const strongCount = progress.filter(isStrong).length;
    const a1Passes = a1Tests.filter((test) => test.assessment?.outcome === "passed").length;

    return {
      memoryReady: true,
      level: a1OralLevel(a1Passes),
      currentFocus: profile?.currentFocus ?? DEFAULT_SNAPSHOT.currentFocus,
      nextLesson: plan.nextLesson,
      upcomingLessons: plan.upcomingLessons,
      reviewOnlyPlanned: profile?.reviewOnlyNextSession === 1,
      dueWords: due,
      wordProgress: progress,
      knownWordCount: progress.length,
      masteredWordCount: strongCount,
      a1Test: {
        eligible: a1TestEligible(strongCount) || a1Passes > 0, passes: a1Passes,
        latest: a1Tests[0]?.assessment ?? null,
        latestAt: a1Tests[0]?.endedAt?.toISOString() ?? null,
      },
      dueWordCount: progress.filter((word) => isDue(word, now)).length,
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

export async function getTutorInstructions(kind: SessionKind = "practice"): Promise<{ instructions: string; snapshot: LearningSnapshot; backendInstructions: string }> {
  const snapshot = await getLearningSnapshot();
  return {
    instructions: kind === "a1_test" ? A1_TEST_INSTRUCTIONS : buildLiveInstructions(snapshot),
    backendInstructions: buildTutorBackendInstructions(snapshot),
    snapshot,
  };
}

export async function beginPracticeSession(kind: SessionKind = "practice"): Promise<number | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    await ensureDatabaseSchema();
    const rows = await getDatabase().insert(practiceSessions).values({ kind, status: "started" }).returning({ id: practiceSessions.id });
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
  const rows = await db.select({ status: practiceSessions.status, progressCursor: practiceSessions.progressCursor, kind: practiceSessions.kind })
    .from(practiceSessions).where(eq(practiceSessions.id, id)).limit(1);
  const session = rows[0];
  if (!session) throw new Error("Samtalen findes ikke.");
  const noChange = async () => ({
    learning: await getLearningSnapshot(),
    progressCursor: session.progressCursor,
    correctWords: [],
    difficultWords: [],
  });
  if (session.kind === "a1_test" || session.status !== "started" || fragments.length <= session.progressCursor) return noChange();

  const fullTranscript = compactTranscript(fragments);
  const processUntil = completedTurnCutoff(fragments);
  const freshTranscript = compactTranscript(fragments.slice(session.progressCursor, processUntil));
  await db.update(practiceSessions).set({ transcript: fullTranscript })
    .where(and(eq(practiceSessions.id, id), eq(practiceSessions.status, "started")));
  await collectTranscriptFeedback(id, fragments);
  if (!freshTranscript.length) return noChange();

  const review = await analyseTranscript(fullTranscript, await getLearningSnapshot(), freshTranscript, id,
    { from: compactTranscript(fragments.slice(0, session.progressCursor)).length,
      to: compactTranscript(fragments.slice(0, processUntil)).length });
  let applied = false;
  await db.transaction(async (tx) => {
    const locked = await tx.select({ progressCursor: practiceSessions.progressCursor, status: practiceSessions.status })
      .from(practiceSessions).where(eq(practiceSessions.id, id)).for("update").limit(1);
    if (locked[0]?.status !== "started" || locked[0]?.progressCursor !== session.progressCursor) return;
    await applyReview(review, false, tx, id, processUntil);
    await tx.update(practiceSessions).set({ progressCursor: processUntil }).where(eq(practiceSessions.id, id));
    applied = true;
  });
  return {
    learning: await getLearningSnapshot(),
    progressCursor: applied ? processUntil : session.progressCursor,
    correctWords: applied ? review.words.filter((word) => word.attempts.some((a) => a.result === "correct" && a.independent && a.mode === "production")).map((word) => word.finnish).slice(0, 8) : [],
    difficultWords: applied ? review.words.filter((word) => word.attempts.some((a) => a.result === "incorrect" && a.independent)).map((word) => word.finnish).slice(0, 8) : [],
  };
}

export async function completePracticeSession(id: number, fragments: TranscriptLine[], interrupted = false): Promise<LearningSnapshot> {
  if (!isDatabaseConfigured()) throw new Error("Læringshukommelsen mangler en databaseforbindelse.");
  if (!fragments.some((line) => line.text.trim())) throw new Error("Samtalen indeholdt ikke noget transkript at gemme.");

  await ensureDatabaseSchema();
  const db = getDatabase();
  const rows = await db.select({ status: practiceSessions.status, progressCursor: practiceSessions.progressCursor, kind: practiceSessions.kind })
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
    await collectTranscriptFeedback(id, fragments);
    if (session.kind === "a1_test") {
      let assessment: A1Assessment;
      try { assessment = interrupted || cleanTranscript.filter((line) => line.speaker === "dig").length < 5
        ? { outcome: "incomplete", checks: { introduction: false, comprehension: false, interaction: false, everydayTask: false },
          evidence: [], needsWork: ["Testen blev afbrudt eller sluttede før alle opgaver kunne vurderes."],
          summary: "A1-taletesten var for kort eller blev afbrudt; den tæller ikke som bestået." }
        : await assessA1Transcript(cleanTranscript, id); }
      catch (error) {
        console.error("Could not assess A1 oral test", error);
        assessment = {
          outcome: "incomplete",
          checks: { introduction: false, comprehension: false, interaction: false, everydayTask: false },
          evidence: [], needsWork: ["Testen blev gemt, men vurderingen mislykkedes teknisk. Prøv igen senere."],
          summary: "A1-taletest gemt uden vurdering på grund af en teknisk fejl.",
        };
      }
      await db.update(practiceSessions)
        .set({ a1Assessment: assessment, summary: assessment.summary,
          recap: { progress: assessment.evidence.slice(0, 3), needsWork: assessment.needsWork.slice(0, 3), nextStep: assessment.outcome === "passed" ? "Tag testen igen i en anden samtale for at bekræfte resultatet." : "Øv de svagere opgaver og prøv A1-taletesten igen." },
          endedAt: new Date(), status: "completed", progressCursor: fragments.length })
        .where(eq(practiceSessions.id, id));
      return getLearningSnapshot();
    }
    const review = await analyseTranscript(cleanTranscript, await getLearningSnapshot(), freshTranscript, id,
      { from: compactTranscript(fragments.slice(0, session.progressCursor)).length, to: cleanTranscript.length });
    await db.transaction(async (tx) => {
      await applyReview(review, true, tx, id, fragments.length);
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

async function assessA1Transcript(transcript: TranscriptLine[], sessionId: number): Promise<A1Assessment> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY mangler på serveren.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-luna", reasoning: { effort: "low" }, store: false, max_output_tokens: 1200,
      input: [
        { role: "system", content: `Assess ONLY the learner's oral A1 test evidence in this transcript. This is an internal speaking/listening check, not an official CEFR certificate. Judge conservatively. The transcript may contain speech-recognition errors; do not infer pronunciation quality from spelling. Do not count answers the tutor supplied first or simple repetition as independent ability. For each of the four checks, give an EXACT short quote from a learner line in the matching position of the evidence array; use an empty string if unmet or unclear. Do not quote tutor lines or invent text. Introduction: simple Finnish personal facts. Comprehension: appropriate answer to Finnish-only questions without prior translation. Interaction: appropriate exchange AND at least one learner-generated Finnish question. EverydayTask: communicates a need and responds to a follow-up in a practical role-play. Set completed=true only if all four distinct tasks were attempted; it does not mean passed. Return summary and specific needsWork in Danish. If audio/turn evidence is insufficient, set the affected check false. Return structured JSON only.` },
        { role: "user", content: JSON.stringify({ transcript }) },
      ],
      text: { format: { type: "json_schema", name: "a1_oral_check", strict: true, schema: {
        type: "object", properties: {
          completed: { type: "boolean" },
          checks: { type: "object", properties: {
            introduction: { type: "boolean" }, comprehension: { type: "boolean" },
            interaction: { type: "boolean" }, everydayTask: { type: "boolean" },
          }, required: ["introduction", "comprehension", "interaction", "everydayTask"], additionalProperties: false },
          evidence: { type: "array", items: { type: "string" } },
          needsWork: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
        }, required: ["completed", "checks", "evidence", "needsWork", "summary"], additionalProperties: false,
      } } },
    }), cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(payload));
  await storeResponseUsage(sessionId, payload);
  const output = responseText(payload);
  if (!output) throw new Error("OpenAI returnerede ingen A1-vurdering.");
  const raw = JSON.parse(output) as { completed: boolean; checks: A1Checks; evidence: string[]; needsWork: string[]; summary: string };
  const learnerText = transcript.filter((line) => line.speaker === "dig").map((line) => line.text);
  const checks = verifyA1Evidence(raw.checks, raw.evidence, learnerText);
  const outcome = determineA1Outcome(raw.completed === true, checks, learnerText.length);
  return {
    outcome, checks,
    evidence: raw.evidence.filter((quote) => typeof quote === "string" && quote.trim()).slice(0, 4),
    needsWork: raw.needsWork.filter((item) => typeof item === "string" && item.trim()).slice(0, 4),
    summary: raw.summary.trim().slice(0, 500) || "Mundtlig A1-test vurderet.",
  };
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

async function analyseTranscript(transcript: TranscriptLine[], memory: LearningSnapshot, scoringTranscript = transcript, sessionId?: number,
  range = { from: 0, to: transcript.length }): Promise<SessionReview> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY mangler på serveren.");

  const numberedTurns = scoringTurns(transcript);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-luna",
      reasoning: { effort: "low" },
      store: false,
      max_output_tokens: 6500,
      input: [
        {
          role: "system",
          content:
            `You evaluate a Finnish tutoring transcript. Evaluate completed learner answers independently of the tutor's praise. Transcription can be imperfect: score only clearly supported attempts; otherwise use introduced. A tutor correction may itself be wrong; accept valid alternatives.
Extract words and grammar results only from scoringTranscript; numberedTurns and priorLearning provide context. Ignore app-feedback notes as lesson material. If scoringTranscript is empty, return empty words and grammar arrays. One word entry per canonical word or SHORT valid Finnish phrase, not every full sentence or inflected restatement. Never store an ungrammatical learner attempt or an English label as a Finnish target. If the learner made a mistake, use the corrected VALID Finnish form as the key. Mention pronunciation only if the tutor explicitly corrected pronunciation; do not infer accent from transcript spelling. Use stable lowercase ASCII keys for grammar topics.
For each word, attempts must list EACH distinct completed learner attempt in the scoring range, with its absolute answerIndex and promptIndex from numberedTurns. The attempt's evidence must be the EXACT WHOLE learner turn, including errors, not a cherry-picked correct fragment. promptEvidence is an exact tutor quote. Use the original index numbers, never renumber. mode=production for saying Finnish from a meaning/roleplay prompt, comprehension for explaining/answering Finnish meaning, repeat for echoing an answer or correction just supplied. independent=false for repeats, hints, or a target supplied within the recent exercise; a translation-back seconds after hearing the target is not delayed independent recall. Keep an initial incorrect independent attempt AND its assisted repair as separate attempts. Do not give multiple credit entries for the same utterance or count its words separately when the whole phrase is the target. A correct production must actually include the target Finnish form; use the valid actually spoken form as the key when alternatives differ. Only include attempts with answerIndex >= scoringRange.from and < scoringRange.to. Use [] for mere introduction or unclear evidence. Report uncertainty by omitting an attempt, never inventing success. The outer result/independent/evidence summarize the last independent attempt (or assisted attempt if none); they do not determine mastery. Evaluate the Finnish answer independently of tutor praise.
Write the summary and recap in concise English. Recap.progress must name up to 3 concrete achievements supported by the transcript; recap.needsWork names up to 3 specific remaining difficulties; recap.nextStep states one actionable next move. Empty arrays are okay; do not invent progress or claim a word is mastered after one success.
For each word result, evidence must be an EXACT short quote from the learner in scoringTranscript. Without a clear learner attempt use introduced and evidence="". independent=true only for unaided retrieval/production or comprehension, with no answer supplied immediately beforehand. Echoing a model or a correction has independent=false even when accurate. Listen through self-corrections and full-duplex backchannels; do not score partial words separately. Evaluate Finnish independently of the tutor's praise: 'paljonko tämä maksaa on' has an extra on; 'uuden' is not 'yhden'; 'menään' is not the correct model for 'I go' (menen). Do not give a correct result simply because the tutor said perfect.
Extract explicit app ideas, requested fixes and persistent teaching preferences into feedbackNotes, even if the learner says them naturally in Danish (for example 'en note til mig selv senere'). Return a concise Danish content and an EXACT quote from learner speech as evidence. Ordinary Finnish mistakes, requests to repeat once and grammar questions are not app feedback. Return [] when none. Never use tutor speech as evidence.
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
              weakestWords: memory.wordProgress.filter((word) => !isStrong(word))
                .sort((a, b) => Number(Boolean(b.evidence?.needsCheck)) - Number(Boolean(a.evidence?.needsCheck)))
                .slice(0, 10).map((word) => ({
                finnish: word.finnish,
                status: expressionStageLabel(word),
                learningEvidence: word.evidence,
              })),
              knownFinnish: memory.wordProgress.map((word) => word.finnish),
            },
            numberedTurns: numberedTurns.map((line, index) => ({ index, ...line })).filter((line) => line.text.trim()),
            scoringRange: range,
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
              feedbackNotes: { type: "array", items: { type: "object", properties: {
                kind: { type: "string", enum: ["idea", "correction"] }, content: { type: "string" }, evidence: { type: "string" },
              }, required: ["kind", "content", "evidence"], additionalProperties: false } },
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
                    independent: { type: "boolean" },
                    evidence: { type: "string" },
                    feedback: { type: "string" },
                    attempts: { type: "array", items: { type: "object", properties: {
                      answerIndex: { type: "integer" }, promptIndex: { type: "integer" },
                      evidence: { type: "string" }, promptEvidence: { type: "string" },
                      mode: { type: "string", enum: ["production", "comprehension", "repeat"] },
                      result: { type: "string", enum: ["correct", "incorrect"] }, independent: { type: "boolean" },
                    }, required: ["answerIndex", "promptIndex", "evidence", "promptEvidence", "mode", "result", "independent"], additionalProperties: false } },
                  },
                  required: ["finnish", "english", "danish", "example", "result", "independent", "evidence", "feedback", "attempts"],
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
            required: ["summary", "level", "currentFocus", "nextLesson", "upcomingLessons", "nextSessionReviewOnly", "newTargets", "feedbackNotes", "recap", "words", "grammar"],
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
  const review = JSON.parse(output) as SessionReview;
  const proposedCount = review.words.reduce((n, word) => n + (word.attempts?.length ?? 0), 0);
  const learnerEvidence = learnerUtterances(scoringTranscript).map(phraseKey);
  for (const word of review.words) {
    word.attempts = verifiedAttempts(word.finnish, word.attempts ?? [], numberedTurns, range);
    const quote = phraseKey(word.evidence ?? "");
    if (!quote || !learnerEvidence.some((line) => line.includes(quote))) {
      word.result = "introduced"; word.independent = false; word.evidence = "";
    }
  }
  // A suggested future target or a fabricated word is not an expression already met.
  review.words = review.words.filter((word) => word.attempts.length > 0 || scoringTranscript.some((line) =>
    ` ${expressionKey(line.text)} `.includes(` ${expressionKey(word.finnish)} `)));
  if (sessionId) {
    const accepted = review.words.flatMap((word) => word.attempts);
    await recordServerDiagnostic({ sessionId, eventType: "backend.expression_analysis", code: "recall-v2",
      phase: "progress", message: JSON.stringify({ proposed: proposedCount, accepted: accepted.length,
        rejected: proposedCount - accepted.length, from: range.from, to: range.to,
        production: accepted.filter((a) => a.mode === "production" && a.independent).length,
        comprehension: accepted.filter((a) => a.mode === "comprehension" && a.independent).length,
        assisted: accepted.filter((a) => !a.independent || a.mode === "repeat").length }) });
  }
  if (sessionId) {
    const utterances = learnerUtterances(transcript);
    for (const note of (review.feedbackNotes ?? []).slice(0, 5)) {
      const evidence = phraseKey(note.evidence);
      if (evidence.length < 20 || !utterances.some((line) => phraseKey(line).includes(evidence))) continue;
      const cues = extractIdeaCues(note.evidence);
      await saveFeedbackNote(sessionId, cues.find((cue) => cue.explicit) ?? cues[0] ?? note);
    }
  }
  return review;
}

async function applyReview(
  review: SessionReview,
  updateProfile: boolean,
  db: Parameters<Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]>[0],
  sessionId: number,
  segmentEnd: number,
): Promise<void> {
  const now = new Date();
  const startedAt = (await db.select({ startedAt: practiceSessions.startedAt }).from(practiceSessions)
    .where(eq(practiceSessions.id, sessionId)).limit(1))[0]?.startedAt ?? now;
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

  const previousWords = await db.select().from(vocabulary);
  for (const word of uniqueBy(review.words, (item) => expressionKey(item.finnish))) {
    const finnish = expressionKey(word.finnish);
    if (!finnish) continue;
    const alias = previousWords.filter((item) => expressionKey(item.finnish) === finnish)
      .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))[0];
    const existing = alias ? await db.select().from(vocabulary).where(eq(vocabulary.id, alias.id)).for("update").limit(1) : [];
    const current = existing[0];
    const values = {
      finnish: current?.finnish ?? finnish,
      english: word.english.trim(),
      danish: word.danish.trim() || null,
      example: word.example.trim() || null,
      // Historical scores are kept as history, never promoted by new v2 events.
      mastery: current?.mastery ?? 0,
      correctCount: current?.correctCount ?? 0,
      incorrectCount: current?.incorrectCount ?? 0,
      lastFeedback: word.result === "incorrect" && word.feedback.trim()
        ? word.feedback.trim().slice(0, 240)
        : current?.lastFeedback ?? null,
      lastSeenAt: now,
      nextReviewAt: current?.nextReviewAt ?? new Date(now.getTime() + 86400_000),
    };
    await db.insert(vocabulary).values(values).onConflictDoUpdate({ target: vocabulary.finnish, set: values });
    await db.insert(practiceItems).values({ sessionId, segmentEnd, finnish, result: word.result,
      independent: word.independent ? 1 : 0, evidence: word.evidence?.slice(0, 500) || null })
      .onConflictDoNothing();
    for (const attempt of word.attempts) {
      const at = attempt.offsetMs === undefined ? now : new Date(startedAt.getTime() + Math.max(0, attempt.offsetMs));
      await db.insert(expressionAttempts).values({ sessionId, answerIndex: attempt.answerIndex, finnish,
        mode: attempt.mode, result: attempt.result, independent: attempt.independent ? 1 : 0,
        evidence: attempt.evidence, promptEvidence: attempt.promptEvidence,
        occurredAt: new Date(Math.min(now.getTime(), at.getTime())) }).onConflictDoNothing();
    }
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
