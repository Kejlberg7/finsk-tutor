import assert from "node:assert/strict";
import test from "node:test";
import { a1OralLevel, a1TestEligible, determineA1Outcome, verifyA1Evidence, type A1Checks } from "../src/lib/a1-test";

const passed: A1Checks = { introduction: true, comprehension: true, interaction: true, everydayTask: true };

test("100 score-strong expressions offer the A1 test, not the A1 label", () => {
  assert.equal(a1TestEligible(99), false);
  assert.equal(a1TestEligible(100), true);
  assert.match(a1OralLevel(0), /A0/);
  assert.match(a1OralLevel(1), /A0/);
  assert.match(a1OralLevel(2), /A1/);
});

test("short or incomplete tests cannot pass even with positive model checks", () => {
  assert.equal(determineA1Outcome(false, passed, 10), "incomplete");
  assert.equal(determineA1Outcome(true, passed, 4), "incomplete");
  assert.equal(determineA1Outcome(true, { ...passed, comprehension: false }, 8), "needs_practice");
  assert.equal(determineA1Outcome(true, passed, 8), "passed");
});

test("a model cannot pass a task by quoting the tutor or inventing learner evidence", () => {
  const quotes = ["Asun Helsingissä", "Minä asun Turussa", "Mitä sinä teet?", "Haluaisin kahvia"];
  const result = verifyA1Evidence(passed, quotes, ["Asun Helsingissä", "Mitä sinä teet?", "Haluaisin kahvia"]);
  assert.equal(result.introduction, true);
  assert.equal(result.comprehension, false);
  assert.equal(result.interaction, true);
  assert.equal(result.everydayTask, true);
  assert.equal(determineA1Outcome(true, result, 8), "needs_practice");
});
