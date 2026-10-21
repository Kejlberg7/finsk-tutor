import type { TranscriptLine, WordProgress } from "./learning-types";

export const EXPRESSION_POLICY = "recall-v2";
export const STRONG_DAYS = 3;
export const STRONG_SPAN_MS = 7 * 86400_000;
const MIN_CHECK_GAP_MS = 20 * 3600_000;

export function expressionKey(value: string): string {
  return value.toLocaleLowerCase("fi-FI").normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function copenhagenDay(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export type AttemptMode = "production" | "comprehension" | "repeat";
export type ExpressionAttempt = {
  finnish: string;
  sessionId: number;
  answerIndex: number;
  mode: AttemptMode;
  result: "correct" | "incorrect";
  independent: boolean;
  evidence: string;
  promptEvidence: string;
  occurredAt: string;
};
export type ExpressionEvidence = {
  policy: typeof EXPRESSION_POLICY;
  attempts: number;
  assistedCorrect: number;
  productionCorrect: number;
  productionIncorrect: number;
  comprehensionCorrect: number;
  comprehensionIncorrect: number;
  productionDays: number;
  firstRecallAt: string | null;
  lastRecallAt: string | null;
  strong: boolean;
  needsCheck: boolean;
  legacyStrong: boolean;
  nextReviewAt: string | null;
  latest: ExpressionAttempt | null;
};

/** An append-only journal, not the number of analysis calls, determines progress. */
export function expressionEvidence(attempts: ExpressionAttempt[], legacyMastery = 0, legacyDue: string | null = null): ExpressionEvidence {
  const state: ExpressionEvidence = { policy: EXPRESSION_POLICY, attempts: 0, assistedCorrect: 0,
    productionCorrect: 0, productionIncorrect: 0, comprehensionCorrect: 0, comprehensionIncorrect: 0,
    productionDays: 0, firstRecallAt: null, lastRecallAt: null, strong: false, needsCheck: false,
    legacyStrong: legacyMastery >= 4, nextReviewAt: legacyDue, latest: null };
  let earned = false;
  let failedAt: number | null = null;
  const seen = new Set<string>();
  for (const attempt of [...attempts].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.answerIndex - b.answerIndex)) {
    const id = `${attempt.sessionId}:${attempt.answerIndex}:${expressionKey(attempt.finnish)}`;
    const at = Date.parse(attempt.occurredAt);
    if (seen.has(id) || !Number.isFinite(at)) continue;
    seen.add(id); state.attempts++; state.latest = attempt;
    const schedule = (days: number) => { state.nextReviewAt = new Date(at + days * 86400_000).toISOString(); };
    if (attempt.mode === "repeat" || !attempt.independent) {
      if (attempt.result === "correct") state.assistedCorrect++;
      // Merely hearing/echoing an item does not shorten an established interval.
      if (!state.nextReviewAt) schedule(1);
      continue;
    }
    if (attempt.mode === "comprehension") {
      if (attempt.result === "correct") state.comprehensionCorrect++;
      else { state.comprehensionIncorrect++; schedule(1); }
      if (!state.nextReviewAt) schedule(3);
      continue;
    }
    if (attempt.result === "incorrect") {
      state.productionIncorrect++; state.needsCheck = true; failedAt = at; schedule(1);
      state.strong = false;
      continue;
    }
    state.productionCorrect++;
    const last = state.lastRecallAt ? Date.parse(state.lastRecallAt) : null;
    const qualifies = last === null || (at - last >= MIN_CHECK_GAP_MS
      && copenhagenDay(new Date(at)) !== copenhagenDay(new Date(last)));
    if (qualifies) {
      state.productionDays++;
      state.firstRecallAt ??= attempt.occurredAt;
      state.lastRecallAt = attempt.occurredAt;
      if (failedAt === null || at - failedAt >= MIN_CHECK_GAP_MS) state.needsCheck = false;
      earned ||= state.productionDays >= STRONG_DAYS && at - Date.parse(state.firstRecallAt) >= STRONG_SPAN_MS;
      const days = earned ? Math.min(60, 14 * Math.max(1, state.productionDays - 2)) : [1, 3, 7][Math.min(2, state.productionDays - 1)];
      schedule(state.needsCheck ? 1 : days);
    }
    state.strong = earned && !state.needsCheck;
  }
  return state;
}

/** Preserve every legacy row in storage; expose one identity without summing duplicate scores. */
export function projectExpressions(words: WordProgress[], attempts: ExpressionAttempt[]): WordProgress[] {
  const groups = new Map<string, WordProgress[]>();
  for (const word of words) {
    const key = expressionKey(word.finnish);
    if (key) groups.set(key, [...(groups.get(key) ?? []), word]);
  }
  const byExpression = new Map<string, ExpressionAttempt[]>();
  for (const attempt of attempts) {
    const key = expressionKey(attempt.finnish);
    byExpression.set(key, [...(byExpression.get(key) ?? []), attempt]);
  }
  return [...groups.entries()].map(([key, variants]) => {
    const latest = [...variants].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))[0];
    const mastery = Math.max(...variants.map((w) => w.mastery));
    const evidence = expressionEvidence(byExpression.get(key) ?? [], mastery, latest.nextReviewAt);
    return { ...latest, finnish: key, mastery,
      correctCount: Math.max(...variants.map((w) => w.correctCount)),
      incorrectCount: Math.max(...variants.map((w) => w.incorrectCount)),
      evidence, nextReviewAt: evidence.nextReviewAt };
  });
}

export function isStrong(word: { mastery: number; evidence?: ExpressionEvidence }): boolean {
  return word.evidence?.strong ?? false;
}

export function expressionStageLabel(word: { mastery: number; evidence?: ExpressionEvidence }): string {
  const e = word.evidence;
  if (e?.needsCheck) return "Kræver et gencheck";
  if (e?.strong) return "Stærkt · bekræftet over tid";
  if (e?.productionCorrect) return "Selvstændigt genkaldt";
  if (e?.legacyStrong || (!e && word.mastery >= 4)) return "Tidligere høj score · afventer bekræftelse";
  if (e?.comprehensionCorrect) return "Forstået · tale mangler at blive testet";
  if (e?.attempts) return "Øvet med hjælp / under indlæring";
  return "Mødt · afventer dokumenteret forsøg";
}

export type ProposedAttempt = {
  answerIndex: number; promptIndex: number; evidence: string; promptEvidence: string;
  mode: AttemptMode; result: "correct" | "incorrect"; independent: boolean;
};

/** Verify both sides against numbered turns. An echo cannot be promoted by model praise. */
export function verifyAttempt(finnish: string, proposed: ProposedAttempt, transcript: TranscriptLine[]): ProposedAttempt | null {
  const answer = transcript[proposed.answerIndex];
  const prompt = transcript[proposed.promptIndex];
  const quote = expressionKey(proposed.evidence);
  const promptQuote = expressionKey(proposed.promptEvidence);
  if (!Number.isInteger(proposed.answerIndex) || !Number.isInteger(proposed.promptIndex)
    || proposed.promptIndex >= proposed.answerIndex || answer?.speaker !== "dig" || prompt?.speaker !== "tutor"
    || !quote || !promptQuote || expressionKey(answer.text) !== quote
    || !` ${expressionKey(prompt.text)} `.includes(` ${promptQuote} `)) return null;
  const target = expressionKey(finnish);
  if (!target || (proposed.mode === "production" && proposed.result === "correct"
    && !` ${quote} `.includes(` ${target} `))) return null;
  const context = transcript.slice(Math.max(0, proposed.promptIndex - 4), proposed.answerIndex).filter((line) => {
    if (line.speaker !== "tutor") return false;
    return line.endMs === undefined || answer.startMs === undefined || answer.startMs - line.endMs <= 60_000;
  });
  const supplied = proposed.mode === "production" && context.some((line) => ` ${expressionKey(line.text)} `.includes(` ${target} `));
  return { ...proposed, mode: supplied ? "repeat" : proposed.mode,
    independent: proposed.mode !== "repeat" && !supplied && proposed.independent };
}

export function verifiedAttempts(finnish: string, proposed: ProposedAttempt[], transcript: TranscriptLine[], range: { from: number; to: number }) {
  const attempts = proposed.flatMap((attempt) => {
    if (attempt.answerIndex < range.from || attempt.answerIndex >= range.to) return [];
    const verified = verifyAttempt(finnish, attempt, transcript);
    return verified ? [{ ...verified, offsetMs: transcript[attempt.answerIndex]?.startMs }] : [];
  });
  // Contradictory duplicate classifications are uncertainty, not extra credit.
  return attempts.filter((attempt, index) => attempts.findIndex((a) => a.answerIndex === attempt.answerIndex) === index
    && !attempts.some((a) => a.answerIndex === attempt.answerIndex
      && (a.result !== attempt.result || a.mode !== attempt.mode || a.independent !== attempt.independent)));
}
