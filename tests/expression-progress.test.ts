import assert from "node:assert/strict";
import test from "node:test";
import { expressionEvidence, expressionKey, expressionStageLabel, isStrong, projectExpressions, verifiedAttempts, verifyAttempt,
  type ExpressionAttempt, type ProposedAttempt } from "../src/lib/expression-progress";
import { practiceCounts, practiceStage, selectReviewWords } from "../src/lib/learning-plan";
import { buildPracticeHistory } from "../src/lib/practice-history";
import type { WordProgress } from "../src/lib/learning-types";
import { completedTurnCutoff, scoringTurns } from "../src/lib/transcript";

const base = "2026-10-01T08:00:00Z";
function attempt(day: number, overrides: Partial<ExpressionAttempt> = {}): ExpressionAttempt {
  return { finnish: "saanko kahvia nyt", sessionId: day + 1, answerIndex: day + 2,
    mode: "production", independent: true, result: "correct", evidence: "Saanko kahvia nyt?",
    promptEvidence: "How do you ask for coffee now?", occurredAt: new Date(Date.parse(base) + day * 86400_000).toISOString(), ...overrides };
}
function word(overrides: Partial<WordProgress> = {}): WordProgress {
  return { finnish: "saanko kahvia nyt?", english: "May I have coffee now?", danish: null, example: null,
    mastery: 5, correctCount: 10, incorrectCount: 0, correctDayCount: 4, lastFeedback: null,
    lastSeenAt: base, nextReviewAt: "2026-10-15T08:00:00Z", ...overrides };
}
const earned = [attempt(0), attempt(1), attempt(7)];

test("legacy scores and old correct days never count as verified strength", () => {
  const w = projectExpressions([word()], [])[0];
  assert.equal(isStrong(w), false);
  assert.equal(w.mastery, 5);
  assert.equal(w.evidence?.legacyStrong, true);
  assert.equal(practiceStage(w), "legacy");
  assert.match(expressionStageLabel(w), /afventer bekræftelse/);
});

test("strength requires three spaced production days spanning at least a week", () => {
  assert.equal(expressionEvidence([attempt(0), attempt(1), attempt(2)]).strong, false);
  assert.equal(expressionEvidence([attempt(0), attempt(7)]).strong, false);
  assert.equal(expressionEvidence(earned).strong, true);
  assert.equal(expressionEvidence(earned).productionDays, 3);
});

test("same-day practice and a midnight crossing cannot manufacture recall days", () => {
  const xs = Array.from({ length: 20 }, (_, i) => attempt(0, { answerIndex: i,
    occurredAt: new Date(Date.parse("2026-10-01T21:50Z") + i * 60_000).toISOString() }));
  const state = expressionEvidence(xs);
  assert.equal(state.productionCorrect, 20);
  assert.equal(state.productionDays, 1);
  assert.equal(state.strong, false);
});

test("a journal retry or duplicate punctuation event is counted once", () => {
  const a = attempt(0);
  const state = expressionEvidence([a, { ...a, finnish: "Saanko kahvia nyt?" }]);
  assert.equal(state.attempts, 1);
});

test("understanding and repetitions do not become production strength", () => {
  const xs = Array.from({ length: 15 }, (_, i) => attempt(i, { mode: i % 2 ? "comprehension" : "repeat" }));
  const state = expressionEvidence(xs);
  assert.equal(state.strong, false);
  assert.equal(state.productionDays, 0);
  assert.equal(state.comprehensionCorrect, 7);
  assert.equal(state.assistedCorrect, 8);
});

test("assisted production is not an independent recall day", () => {
  const state = expressionEvidence(earned.map((a) => ({ ...a, independent: false })));
  assert.equal(state.productionCorrect, 0);
  assert.equal(state.assistedCorrect, 3);
});

test("a failed retrieval remains visible after an assisted repair", () => {
  const xs = [attempt(0, { result: "incorrect" }), attempt(0, { mode: "repeat", answerIndex: 99 })];
  const state = expressionEvidence(xs);
  assert.equal(state.productionIncorrect, 1);
  assert.equal(state.assistedCorrect, 1);
  assert.equal(state.needsCheck, true);
  assert.equal(state.strong, false);
});

test("a lapse temporarily flags strength; a delayed independent recheck restores earned progress", () => {
  const failed = [...earned, attempt(8, { result: "incorrect" })];
  assert.equal(expressionEvidence(failed).strong, false);
  assert.equal(expressionEvidence(failed).needsCheck, true);
  const repaired = expressionEvidence([...failed, attempt(9)]);
  assert.equal(repaired.strong, true);
  assert.equal(repaired.needsCheck, false);
  assert.equal(repaired.productionDays, 4);
});

test("repetition/comprehension success do not shorten or postpone an established strong interval", () => {
  const before = expressionEvidence(earned);
  const after = expressionEvidence([...earned, attempt(8, { mode: "repeat" }), attempt(9, { mode: "comprehension" })]);
  assert.equal(after.nextReviewAt, before.nextReviewAt);
  assert.equal(after.strong, true);
});

test("merely repeating a legacy item keeps its old review date", () => {
  const state = expressionEvidence([attempt(0, { mode: "repeat" })], 5, "2026-11-01T08:00:00Z");
  assert.equal(state.nextReviewAt, "2026-11-01T08:00:00Z");
});

test("a failed comprehension check schedules review without pretending production was tested", () => {
  const state = expressionEvidence([...earned, attempt(8, { mode: "comprehension", result: "incorrect" })]);
  assert.equal(state.comprehensionIncorrect, 1);
  assert.equal(state.productionIncorrect, 0);
  assert.equal(state.nextReviewAt, attempt(9).occurredAt);
});

test("canonical identity handles case, Unicode and punctuation without merging different Finnish forms", () => {
  assert.equal(expressionKey("  MITÄ kuuluu?! "), "mitä kuuluu");
  assert.equal(expressionKey("hyva\u0308a\u0308"), "hyvää");
  assert.notEqual(expressionKey("töissä"), expressionKey("töihin"));
  const originals = [word(), word({ finnish: "Saanko kahvia nyt.", mastery: 2, correctCount: 2 })];
  const projected = projectExpressions(originals, earned);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].mastery, 5);
  assert.equal(projected[0].correctCount, 10);
  assert.equal(originals.length, 2);
  assert.equal(practiceCounts(projected).secure, 1);
});

const proposed: ProposedAttempt = { answerIndex: 1, promptIndex: 0, evidence: "Saanko kahvia nyt",
  promptEvidence: "How would you ask for coffee now", mode: "production", result: "correct", independent: true };

test("attempt evidence must match a learner turn and the actual preceding tutor prompt", () => {
  const lines = [{ speaker: "tutor" as const, text: "How would you ask for coffee now?" },
    { speaker: "dig" as const, text: "Saanko kahvia nyt?" }];
  assert.equal(verifyAttempt("saanko kahvia nyt", proposed, lines)?.independent, true);
  assert.equal(verifyAttempt("saanko kahvia nyt", { ...proposed, answerIndex: 0 }, lines), null);
  assert.equal(verifyAttempt("saanko kahvia nyt", { ...proposed, evidence: "invented success" }, lines), null);
  assert.equal(verifyAttempt("saanko kahvia nyt", { ...proposed, promptIndex: 1 }, lines), null);
});

test("short evidence cannot match a substring inside another word", () => {
  assert.equal(verifyAttempt("on", { ...proposed, evidence: "on" }, [
    { speaker: "tutor", text: "How would you ask for coffee now?" }, { speaker: "dig", text: "lektion" },
  ]), null);
});

test("a correct-looking quote cannot hide an extra erroneous word or a Danish-only answer", () => {
  assert.equal(verifyAttempt("saanko kahvia nyt", proposed, [
    { speaker: "tutor", text: "How would you ask for coffee now?" },
    { speaker: "dig", text: "Saanko kahvia nyt on" },
  ]), null);
  assert.equal(verifyAttempt("saanko kahvia nyt", { ...proposed, evidence: "Må jeg få kaffe nu" }, [
    { speaker: "tutor", text: "How would you ask for coffee now?" },
    { speaker: "dig", text: "Må jeg få kaffe nu" },
  ]), null);
});

test("a supplied target or immediate translation-back is deterministically marked assisted", () => {
  const lines = [{ speaker: "tutor" as const, text: "Saanko kahvia nyt. How would you ask for coffee now?" },
    { speaker: "dig" as const, text: "Saanko kahvia nyt?" }];
  const result = verifyAttempt("saanko kahvia nyt", proposed, lines);
  assert.equal(result?.mode, "repeat");
  assert.equal(result?.independent, false);
});

test("checkpoint range excludes old and unfinished turns; conflicting duplicate results are not credited", () => {
  const lines = [
    { speaker: "tutor" as const, text: "How would you ask for coffee now?", startMs: 0 },
    { speaker: "dig" as const, text: "Saanko kahvia nyt?", startMs: 5000 },
    { speaker: "tutor" as const, text: "How would you ask for coffee now?", startMs: 7000 },
    { speaker: "dig" as const, text: "Saanko kahvia nyt?", startMs: 10000 },
  ];
  const later = { ...proposed, answerIndex: 3, promptIndex: 2 };
  assert.deepEqual(verifiedAttempts("saanko kahvia nyt", [proposed, later], lines, { from: 2, to: 3 }), []);
  assert.equal(verifiedAttempts("saanko kahvia nyt", [proposed, later], lines, { from: 2, to: 4 })[0].offsetMs, 10000);
  assert.equal(verifiedAttempts("saanko kahvia nyt", [later, later], lines, { from: 2, to: 4 }).length, 1);
  assert.equal(verifiedAttempts("saanko kahvia nyt", [later, { ...later, result: "incorrect" }], lines, { from: 2, to: 4 }).length, 0);
});

test("a listening backchannel cannot split an unfinished answer into scored fragments", () => {
  const lines = [
    { speaker: "tutor" as const, text: "How would you ask for coffee now?", startMs: 0, endMs: 1000 },
    { speaker: "dig" as const, text: "Saanko kahvia", startMs: 2000, endMs: 3000 },
    { speaker: "tutor" as const, text: "Yes,", startMs: 3000, endMs: 3200 },
    { speaker: "dig" as const, text: "nyt", startMs: 3500, endMs: 4000 },
    { speaker: "tutor" as const, text: "That is the complete expression. Next question.", startMs: 4000, endMs: 6000 },
  ];
  assert.equal(completedTurnCutoff(lines), 1);
  const turns = scoringTurns(lines);
  assert.equal(turns[1].text, "Saanko kahvia nyt");
  assert.equal(turns[3].text, "");
  assert.equal(verifyAttempt("saanko kahvia nyt", proposed, turns)?.independent, true);
  const complete = [...lines, { speaker: "dig" as const, text: "Next answer", startMs: 7000, endMs: 8000 },
    { speaker: "tutor" as const, text: "Now try a different expression", startMs: 9000, endMs: 10000 }];
  assert.equal(completedTurnCutoff(complete), 5);
});

test("history strong filter and snapshot count use the same verified evidence", () => {
  const words = projectExpressions([word(), word({ finnish: "kiitos" })], earned);
  const history = buildPracticeHistory(words, [], [], { scope: "strong", days: 7, query: "", offset: 0, limit: 8 });
  assert.equal(history.total, 1);
  assert.equal(history.items[0].learningEvidence?.strong, true);
});

test("review includes at most one legacy-high item and prioritizes an actual new lapse", () => {
  const legacy = Array.from({ length: 10 }, (_, i) => word({ finnish: `legacy${i}`, nextReviewAt: base }));
  const failing = word({ finnish: "uusi", mastery: 0, incorrectCount: 3, nextReviewAt: base });
  const projected = projectExpressions([...legacy, failing], [attempt(0, { finnish: "uusi", result: "incorrect" })]);
  const selected = selectReviewWords(projected, new Date("2026-10-10T08:00Z"));
  assert.equal(selected.filter((w) => w.evidence?.legacyStrong).length, 1);
  assert.equal(selected[0].finnish, "uusi");
});
