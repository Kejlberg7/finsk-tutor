import assert from "node:assert/strict";
import test from "node:test";
import { buildPracticeHistory, historyPage, historyStartDay, parseHistoryQuery, type HistoryQuery } from "../src/lib/practice-history";
import { extractIdeaCues } from "../src/lib/idea-cue";
import { learnerUtterances } from "../src/lib/transcript";
import { makeSessionRecovery, parseSessionRecovery } from "../src/lib/session-recovery";
import { tutorIntervention } from "../src/lib/tutor-interventions";
import type { WordProgress } from "../src/lib/learning-types";
import { expressionEvidence } from "../src/lib/expression-progress";

const word = (finnish: string, mastery = 4): WordProgress => ({ finnish, mastery, english: "Example", danish: null,
  example: null, correctCount: 4, incorrectCount: 0, correctDayCount: 2, lastFeedback: null,
  lastSeenAt: "2026-10-21T06:00:00Z", nextReviewAt: "2026-10-23T06:00:00Z",
  evidence: expressionEvidence(mastery >= 4 ? [0, 1, 7].map((day) => ({ finnish, sessionId: day + 1, answerIndex: 1,
    mode: "production", independent: true, result: "correct", evidence: finnish, promptEvidence: "Say it in Finnish",
    occurredAt: new Date(Date.parse("2026-10-01T08:00Z") + day * 86400_000).toISOString() })) : []) });
const query: HistoryQuery = { scope: "this_week", days: 3, query: "", offset: 0, limit: 2 };
const now = new Date("2026-10-21T08:00:00Z");

test("history uses actual session evidence and dates, not vocabulary last-seen timestamps", () => {
  const result = buildPracticeHistory([word("vanha lause"), word("saanko kahvia nyt"), word("onko huoneessa oma kylpyhuone"), word("on")], [
    { id: 1, startedAt: "2026-10-02T06:00:00Z", transcript: [{ speaker: "dig", text: "vanha lause" }] },
    { id: 2, startedAt: "2026-10-20T06:00:00Z", transcript: [
      { speaker: "dig", text: "Saanko kahvia nyt?" },
      { speaker: "tutor", text: "Onko huoneessa oma kylpyhuone?" },
      { speaker: "dig", text: "Jeg tror det er sådan man siger det on dansk" },
    ] },
  ], [], { ...query, limit: 8 }, now);
  assert.equal(result.total, 2);
  assert.equal(result.items.find((x) => x.finnish === "saanko kahvia nyt")?.dates[0].evidence, "transcript_attempt_unscored");
  assert.equal(result.items.find((x) => x.finnish.startsWith("onko"))?.dates[0].evidence, "transcript_exposure_only");
  assert.equal(result.items[0].dates[0].day, "2026-10-20");
});

test("dated scored attempts survive imperfect transcription; strong list pagination covers every item once", () => {
  const words = [word("yksi lippu"), word("et saa mennä"), word("missä on hotelli"), word("kiitos", 1)];
  const sessions = [{ id: 3, startedAt: "2026-10-21T06:00:00Z", transcript: [] }];
  const occurrences = [{ sessionId: 3, finnish: "et saa mennä", result: "incorrect", occurredAt: now.toISOString() }];
  assert.equal(buildPracticeHistory(words, sessions, occurrences, query, now).items[0].dates[0].evidence, "scored_attempt");
  const first = buildPracticeHistory(words, sessions, occurrences, { ...query, scope: "strong" }, now);
  assert.equal(first.total, 3);
  const second = buildPracticeHistory(words, sessions, occurrences, { ...query, scope: "strong", offset: first.nextOffset! }, now);
  assert.equal(new Set([...first.items, ...second.items].map((x) => x.finnish)).size, 3);
  assert.equal(second.nextOffset, null);
});

test("history calendar boundaries use Copenhagen including a UTC Sunday that is local Monday", () => {
  assert.equal(historyStartDay(query, new Date("2026-10-18T23:30:00Z")), "2026-10-19");
  assert.equal(historyStartDay({ ...query, scope: "recent_days", days: 2 }, now), "2026-10-20");
  assert.equal(parseHistoryQuery({ ...query, limit: 100 }), null);
  assert.equal(parseHistoryQuery({ ...query, offset: -1 }), null);
});

test("actual October feedback is captured through backchannels and natural note wording", () => {
  const spoken = "Øh, det skal vi have lavet om på, så det er en note til mig selv senere at, du skal kunne kalde et API eller et eller andet til, som kan give dig en liste af alt det jeg burde kunne finde ud af, så vi kan gennemgå det en af gangen";
  const cue = extractIdeaCues(spoken)[0];
  assert.equal(cue.explicit, true);
  assert.match(cue.content, /kalde et API/);
  assert.equal(extractIdeaCues("Du skal altid holde dansk ud af det og bruge engelsk")[0].kind, "correction");
  const utterances = learnerUtterances([
    { speaker: "dig", text: "Det er en note til mig selv senere at ", startMs: 0, endMs: 2000 },
    { speaker: "tutor", text: "Okay.", startMs: 2000, endMs: 2200 },
    { speaker: "dig", text: "du skal kunne finde mine tidligere sætninger", startMs: 2200, endMs: 5000 },
  ]);
  assert.equal(utterances.length, 1);
  assert.match(extractIdeaCues(utterances[0])[0].content, /tidligere sætninger/);
  assert.deepEqual(extractIdeaCues("Kan du forklare hvad pitää betyder?"), []);
});

test("recovery preserves context and elapsed practice while rejecting stale or malformed saved data", () => {
  const saved = makeSessionRecovery([{ speaker: "dig", text: "Vi øver hotelspørgsmål" }], 1100, "content", "practice");
  assert.equal(parseSessionRecovery(JSON.stringify(saved))?.elapsedSeconds, 1100);
  assert.equal(parseSessionRecovery(JSON.stringify(saved))?.reason, "content");
  assert.equal(parseSessionRecovery(JSON.stringify({ ...saved, savedAt: Date.now() - 13 * 3600_000 })), null);
  assert.equal(parseSessionRecovery(JSON.stringify({ ...saved, transcript: [{ speaker: "invalid", text: "x" }] })), null);
});

test("runtime nudges catch observed language drift and premature wrap-ups", () => {
  assert.equal(tutorIntervention("How would you say hvor meget koster det?", 600)?.code, "coaching_language");
  assert.equal(tutorIntervention("Want to keep going?", 800)?.code, "early_wrap_up");
  assert.equal(tutorIntervention("Want to keep going?", 1900), null);
  assert.equal(tutorIntervention("Menään aamiaiselle", 600)?.code, "finnish_model_form");
  assert.equal(tutorIntervention("What does that mean in Danish?", 600), null);
});

test("a pinned review set stays stable when new practice changes word scores or ordering", () => {
  const result = buildPracticeHistory([word("a lause"), word("b lause"), word("c lause")], [], [], { ...query, scope: "all", limit: 100 }, now);
  const state = { queryKey: "all", asOf: now.toISOString(), lastOffset: 0, result };
  assert.deepEqual(historyPage(state, 2, 2).items.map((item) => item.finnish), ["c lause"]);
  assert.equal(historyPage(state, 2, 2).nextOffset, null);
});

test("punctuation variants do not become separate review targets", () => {
  const result = buildPracticeHistory([word("Saanko kahvia nyt?"), word("saanko kahvia nyt.")], [], [], { ...query, scope: "all" }, now);
  assert.equal(result.total, 1);
});
