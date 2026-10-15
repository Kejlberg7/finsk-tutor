export const A1_TEST_STRONG_GOAL = 100;
export const A1_TEST_PASSES_REQUIRED = 2;
export type SessionKind = "practice" | "a1_test";

export type A1Checks = {
  introduction: boolean;
  comprehension: boolean;
  interaction: boolean;
  everydayTask: boolean;
};

export type A1Assessment = {
  outcome: "passed" | "needs_practice" | "incomplete";
  checks: A1Checks;
  evidence: string[];
  needsWork: string[];
  summary: string;
};

export function a1TestEligible(strongExpressions: number): boolean {
  return strongExpressions >= A1_TEST_STRONG_GOAL;
}

export function determineA1Outcome(completed: boolean, checks: A1Checks, learnerTurns: number): A1Assessment["outcome"] {
  if (!completed || learnerTurns < 5) return "incomplete";
  return Object.values(checks).every(Boolean) ? "passed" : "needs_practice";
}

export function verifyA1Evidence(checks: A1Checks, evidence: string[], learnerLines: string[]): A1Checks {
  const lines = learnerLines.map((line) => line.toLocaleLowerCase("fi-FI"));
  const keys = ["introduction", "comprehension", "interaction", "everydayTask"] as const;
  return Object.fromEntries(keys.map((key, index) => {
    const quote = evidence[index]?.trim().toLocaleLowerCase("fi-FI") ?? "";
    return [key, checks[key] === true && quote.length >= 3 && lines.some((line) => line.includes(quote))];
  })) as A1Checks;
}

export function a1OralLevel(passCount: number): string {
  return passCount >= A1_TEST_PASSES_REQUIRED ? "Mundtligt A1 · appvurderet" : "A0 · på vej mod A1";
}
