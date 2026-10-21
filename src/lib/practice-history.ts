import type { TranscriptLine, WordProgress } from "./learning-types";
import { copenhagenDay } from "./learning-plan";
import { expressionKey, expressionStageLabel, isStrong } from "./expression-progress";

export type HistoryScope = "recent_days" | "this_week" | "strong" | "due" | "all";
export type HistoryQuery = { scope: HistoryScope; days: number; query: string; offset: number; limit: number };
export type PracticeOccurrence = { sessionId: number; finnish: string; result: string; occurredAt: string };
export type HistorySession = { id: number; startedAt: string; transcript: TranscriptLine[] };
export type HistoryResult = ReturnType<typeof buildPracticeHistory>;
export type HistoryState = { queryKey: string; asOf: string; lastOffset: number; result: HistoryResult };

export function historyQueryKey(query: HistoryQuery) {
  return JSON.stringify(["recall-v2", query.scope, query.scope === "recent_days" ? query.days : null, phraseKey(query.query)]);
}

export function historyPage(state: HistoryState, offset: number, limit: number) {
  return { ...state.result, asOf: state.asOf, offset,
    nextOffset: offset + limit < state.result.total ? offset + limit : null,
    items: state.result.items.slice(offset, offset + limit).map((item) => ({ ...item,
      practiceSessionCount: item.dates.length, dates: item.dates.slice(0, 5) })) };
}

export function parseHistoryQuery(value: unknown): HistoryQuery | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!["recent_days", "this_week", "strong", "due", "all"].includes(String(v.scope))
    || !Number.isInteger(v.offset) || Number(v.offset) < 0 || Number(v.offset) > 50_000
    || !Number.isInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 8
    || (v.days != null && (!Number.isInteger(v.days) || Number(v.days) < 1 || Number(v.days) > 30))
    || (v.query != null && (typeof v.query !== "string" || v.query.length > 100))) return null;
  return { scope: v.scope as HistoryScope, days: Number(v.days ?? 3), query: String(v.query ?? "").trim(), offset: Number(v.offset), limit: Number(v.limit) };
}

export function historyStartDay(query: HistoryQuery, now: Date): string | null {
  if (query.scope !== "recent_days" && query.scope !== "this_week") return null;
  const today = copenhagenDay(now);
  const date = new Date(`${today}T12:00:00Z`);
  const ago = query.scope === "this_week" ? (date.getUTCDay() + 6) % 7 : query.days - 1;
  date.setUTCDate(date.getUTCDate() - ago);
  return date.toISOString().slice(0, 10);
}

export function phraseKey(value: string): string {
  return expressionKey(value);
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${phraseKey(text)} `.includes(` ${phrase} `);
}

/** Legacy dates come from literal transcript evidence, never today's last_seen_at. */
export function buildPracticeHistory(words: WordProgress[], sessions: HistorySession[], occurrences: PracticeOccurrence[], query: HistoryQuery, now = new Date()) {
  const startDay = historyStartDay(query, now);
  const today = copenhagenDay(now);
  const matchingSessions = sessions.filter((s) => {
    const day = copenhagenDay(new Date(s.startedAt));
    return day <= today && (!startDay || day >= startDay);
  });
  const canonical = new Map<string, WordProgress>();
  for (const word of words) {
    const key = phraseKey(word.finnish);
    const previous = canonical.get(key);
    if (!previous || (word.lastSeenAt ?? "") > (previous.lastSeenAt ?? "")) canonical.set(key, word);
  }
  const items = [...canonical.values()].flatMap((word) => {
    const key = phraseKey(word.finnish);
    if (!key || (query.query && !phraseKey(`${word.finnish} ${word.english} ${word.danish ?? ""}`).includes(phraseKey(query.query)))) return [];
    if (query.scope === "strong" && !isStrong(word)) return [];
    if (query.scope === "due" && word.nextReviewAt && new Date(word.nextReviewAt) > now) return [];
    const dated: Array<{ sessionId: number; day: string; evidence: string }> = [];
    for (const s of matchingSessions) {
      const records = occurrences.filter((o) => o.sessionId === s.id && phraseKey(o.finnish) === key);
      if (records.length) {
        dated.push({ sessionId: s.id, day: copenhagenDay(new Date(s.startedAt)), evidence: records.some((o) => o.result !== "introduced") ? "scored_attempt" : "introduced" });
        continue;
      }
      // Single words in Danish/English are ambiguous. Only accept an exact answer for those.
      const learner = s.transcript.some((line) => line.speaker === "dig" &&
        (key.includes(" ") ? containsPhrase(line.text, key) : phraseKey(line.text) === key));
      const tutor = key.includes(" ") && s.transcript.some((line) => line.speaker === "tutor" && containsPhrase(line.text, key));
      if (learner || tutor) dated.push({ sessionId: s.id, day: copenhagenDay(new Date(s.startedAt)), evidence: learner ? "transcript_attempt_unscored" : "transcript_exposure_only" });
    }
    if (startDay && !dated.length) return [];
    return [{ finnish: word.finnish, english: word.english, mastery: word.mastery,
      status: expressionStageLabel(word), learningEvidence: word.evidence ?? null,
      correctDayCount: word.correctDayCount, correctCount: word.correctCount, incorrectCount: word.incorrectCount,
      lastFeedback: word.lastFeedback, dates: dated.sort((a, b) => b.day.localeCompare(a.day)) }];
  }).sort((a, b) => startDay
    ? (b.dates[0]?.day ?? "").localeCompare(a.dates[0]?.day ?? "") || a.finnish.localeCompare(b.finnish, "fi")
    : a.finnish.localeCompare(b.finnish, "fi"));
  return { scope: query.scope, fromDay: startDay, throughDay: today, total: items.length, offset: query.offset,
    nextOffset: query.offset + query.limit < items.length ? query.offset + query.limit : null,
    items: items.slice(query.offset, query.offset + query.limit),
    evidenceNote: "Strong means independent production on 3 spaced days across at least 7 days, without an unresolved production error. Legacy mastery is historical. learningEvidence separates comprehension, production and repetition. Transcript matches alone do not prove correctness; empty dates support no date claim." };
}
