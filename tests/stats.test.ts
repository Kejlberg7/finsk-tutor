import assert from "node:assert/strict";
import test from "node:test";
import { buildPracticeStats, localDayKey, type PracticeStat } from "../src/lib/stats";

test("practice days use Danish local dates, including daylight-saving boundaries", () => {
  assert.equal(localDayKey("2026-03-28T23:30:00Z"), "2026-03-29");
  assert.equal(localDayKey("2026-10-24T22:30:00Z"), "2026-10-25");
});

test("statistics combine resumed conversation parts into the same practice day", () => {
  const sessions: PracticeStat[] = [
    { id: 3, startedAt: "2026-10-13T07:00:00Z", durationSeconds: 600, estimatedCostUsd: 0.5, status: "completed" },
    { id: 2, startedAt: "2026-10-12T15:00:00Z", durationSeconds: 720, estimatedCostUsd: 0.6, status: "completed" },
    { id: 1, startedAt: "2026-10-12T08:00:00Z", durationSeconds: 1200, estimatedCostUsd: 1, status: "completed" },
  ];
  const result = buildPracticeStats(sessions, new Date("2026-10-13T10:00:00Z"));
  assert.equal(result.totalSeconds, 2520);
  assert.equal(result.activeDays, 2);
  assert.equal(result.currentStreak, 2);
  assert.equal(result.longestStreak, 2);
  assert.equal(result.goalDays, 1);
  assert.equal(result.averageSeconds, 840);
  assert.equal(result.longestSessionSeconds, 1200);
  assert.equal(result.bestDay?.date, "2026-10-12");
  assert.equal(result.bestDay?.seconds, 1920);
  assert.equal(result.recentDays.at(-1)?.seconds, 600);
  assert.equal(result.heatmap.length, 84);
});

test("a streak stays current through yesterday but expires after a missed day", () => {
  const yesterday: PracticeStat[] = [{
    id: 1, startedAt: "2026-10-12T08:00:00Z", durationSeconds: 60, estimatedCostUsd: 0, status: "completed",
  }];
  assert.equal(buildPracticeStats(yesterday, new Date("2026-10-13T10:00:00Z")).currentStreak, 1);
  assert.equal(buildPracticeStats(yesterday, new Date("2026-10-14T10:00:00Z")).currentStreak, 0);
  assert.equal(buildPracticeStats([], new Date("2026-10-13T10:00:00Z")).bestDay, null);
});
