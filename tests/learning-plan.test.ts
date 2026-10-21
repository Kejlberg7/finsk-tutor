import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLessonPlan, chooseNewTargets, copenhagenDay, practiceCounts, practiceStage, selectReviewWords,
  type PracticeEvidence,
} from "../src/lib/learning-plan";

const now = new Date("2026-10-14T12:00:00Z");

function word(finnish: string, correctCount: number, incorrectCount: number, mastery = correctCount): PracticeEvidence {
  return {
    finnish, english: finnish, correctCount, incorrectCount, mastery, correctDayCount: 0,
    lastSeenAt: "2026-10-01T12:00:00Z", nextReviewAt: "2026-10-02T12:00:00Z",
  };
}

test("practice evidence separates introduction, one attempt, repeated practice and score", () => {
  const words = [word("tänään", 0, 0), word("kiitos", 1, 0), word("kotiin", 2, 1), { ...word("haluan levätä", 5, 0, 5), correctDayCount: 2 }];
  assert.deepEqual(words.map(practiceStage), ["introduced", "once", "practicing", "legacy"]);
  assert.deepEqual(practiceCounts(words), { introduced: 1, once: 1, practicing: 1, legacy: 1, secure: 0, confirmedAcrossDays: 0 });
});

test("review sample is small, mixed and never models an uncorrected error", () => {
  const words = [
    word("wrong learner phrase", 0, 3, 0),
    word("growing", 2, 1, 1),
    word("once a", 1, 0, 1), word("once b", 1, 0, 1),
    word("introduced", 0, 0, 0), word("secure", 5, 0, 5),
    ...Array.from({ length: 20 }, (_, index) => word(`extra ${index}`, 1, 0, 1)),
  ];
  const selected = selectReviewWords(words, now);
  assert.equal(selected.length, 5);
  assert.deepEqual(selected.map((item) => item.finnish), ["growing", "once a", "introduced", "secure", "once b"]);
  assert.equal(selected.some((item) => item.finnish === "wrong learner phrase"), false);
});

test("near-duplicates of secure phrases do not consume the review slots", () => {
  const secureGreeting = { ...word("ihan hyvää, kiitos", 5, 0, 5), nextReviewAt: "2026-11-01T12:00:00Z" };
  const selected = selectReviewWords([
    secureGreeting,
    word("ihan hyvää", 1, 0, 1),
    word("ihan hyvin, kiitos", 1, 0, 1),
    word("paljonko tämä maksaa?", 1, 0, 1),
    word("tarvitsen apua", 2, 0, 2),
  ], now);
  assert.deepEqual(selected.map((item) => item.finnish), ["tarvitsen apua", "paljonko tämä maksaa?"]);
});

test("old review-only titles cannot keep future lessons in a loop", () => {
  const known = [word("ihan hyvää, kiitos", 10, 0, 5)];
  const plan = buildLessonPlan(known, [{ finnish: "ihan hyvää, kiitos", english: "I am fine" },
    { finnish: "paljonko tämä maksaa?", english: "How much does this cost?" }], false, now);
  assert.equal(plan.upcomingLessons.length, 3);
  assert.match(plan.upcomingLessons[0], /paljonko tämä maksaa/);
  assert.equal(plan.upcomingLessons[0], plan.nextLesson);
  assert.ok(plan.upcomingLessons.some((block) => block.includes("beslægtet variation")));
  assert.ok(plan.newTargets.every((target) => target.finnish !== "ihan hyvää, kiitos"));
  assert.equal(chooseNewTargets(known, [plan.newTargets[0]]).length, 1);
});

test("only an explicit review-only mode suppresses new targets", () => {
  const plan = buildLessonPlan([word("kiitos", 1, 0)], [], true, now);
  assert.equal(plan.newTargets.length, 0);
  assert.ok(plan.upcomingLessons.every((block) => !block.includes("haluan tilata kahvia")));
});

test("correct days use Copenhagen local calendar days", () => {
  assert.equal(copenhagenDay(new Date("2026-10-14T21:30:00Z")), "2026-10-14");
  assert.equal(copenhagenDay(new Date("2026-10-14T22:30:00Z")), "2026-10-15");
});
