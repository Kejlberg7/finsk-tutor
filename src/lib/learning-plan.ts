export type PracticeEvidence = {
  finnish: string;
  english: string;
  mastery: number;
  correctCount: number;
  incorrectCount: number;
  correctDayCount: number;
  lastSeenAt: string | null;
  nextReviewAt: string | null;
};

export type PracticeStage = "introduced" | "once" | "practicing" | "secure";
export type NewTarget = { finnish: string; english: string };

export function practiceStage(word: PracticeEvidence): PracticeStage {
  const attempts = word.correctCount + word.incorrectCount;
  if (attempts === 0) return "introduced";
  if (attempts === 1) return "once";
  return word.mastery >= 4 ? "secure" : "practicing";
}

export function practiceCounts(words: PracticeEvidence[]) {
  const counts = { introduced: 0, once: 0, practicing: 0, secure: 0, confirmedAcrossDays: 0 };
  for (const word of words) {
    counts[practiceStage(word)] += 1;
    if (word.mastery >= 4 && word.correctDayCount >= 2) counts.confirmedAcrossDays += 1;
  }
  return counts;
}

export function isDue(word: PracticeEvidence, now = new Date()): boolean {
  return !word.nextReviewAt || new Date(word.nextReviewAt).getTime() <= now.getTime();
}

// A due backlog is not a lesson script. Mix stages and never present an uncorrected
// learner error (zero correct attempts) as an example of good Finnish.
export function selectReviewWords<T extends PracticeEvidence>(words: T[], now = new Date(), limit = 5): T[] {
  const due = words.filter((word) => isDue(word, now));
  const secure = words.filter((word) => word.mastery >= 4);
  const useful = due.filter((word) => word.correctCount > 0 || word.incorrectCount === 0)
    .filter((word) => word.incorrectCount > 0 || word.mastery >= 4
      || !secure.some((known) => known.finnish !== word.finnish && phraseSimilarity(known.finnish, word.finnish) >= 0.5));
  const byAge = (a: T, b: T) => (a.nextReviewAt ?? "").localeCompare(b.nextReviewAt ?? "")
    || (a.lastSeenAt ?? "").localeCompare(b.lastSeenAt ?? "");
  const groups = {
    practicing: useful.filter((word) => practiceStage(word) === "practicing").sort(byAge),
    once: useful.filter((word) => practiceStage(word) === "once").sort(byAge),
    introduced: useful.filter((word) => practiceStage(word) === "introduced").sort(byAge),
    secure: useful.filter((word) => practiceStage(word) === "secure").sort(byAge),
  };
  const selected: T[] = [];
  for (const stage of ["practicing", "once", "once", "introduced", "secure"] as const) {
    const index = groups[stage].findIndex((word) => selected.every((picked) => phraseSimilarity(word.finnish, picked.finnish) < 0.5));
    const word = index < 0 ? undefined : groups[stage].splice(index, 1)[0];
    if (word) selected.push(word);
  }
  for (const word of [...groups.practicing, ...groups.once, ...groups.introduced, ...groups.secure]) {
    if (selected.length >= limit) break;
    if (selected.every((picked) => phraseSimilarity(word.finnish, picked.finnish) < 0.5)) selected.push(word);
  }
  return selected.slice(0, limit);
}

function phraseSimilarity(first: string, second: string): number {
  const a = new Set(key(first).split(/[^\p{L}]+/u).filter(Boolean));
  const b = new Set(key(second).split(/[^\p{L}]+/u).filter(Boolean));
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / (a.size + b.size - intersection || 1);
}

const FALLBACK_TARGETS: NewTarget[] = [
  { finnish: "haluan tilata kahvia", english: "I want to order coffee" },
  { finnish: "paljonko tämä maksaa?", english: "How much does this cost?" },
  { finnish: "missä on asema?", english: "Where is the station?" },
  { finnish: "voinko maksaa kortilla?", english: "Can I pay by card?" },
  { finnish: "milloin bussi lähtee?", english: "When does the bus leave?" },
  { finnish: "tarvitsen apua", english: "I need help" },
  { finnish: "haluaisin vettä", english: "I would like some water" },
  { finnish: "onko tämä ilmainen?", english: "Is this free of charge?" },
  { finnish: "mihin aikaan tapaamme?", english: "What time shall we meet?" },
  { finnish: "olen täällä ensimmäistä kertaa", english: "I am here for the first time" },
  { finnish: "missä voin ostaa lipun?", english: "Where can I buy a ticket?" },
  { finnish: "voisitko puhua hitaammin?", english: "Could you speak more slowly?" },
  { finnish: "mitä suosittelet?", english: "What do you recommend?" },
  { finnish: "olen menossa kauppaan", english: "I am going to the shop" },
  { finnish: "kävin eilen kävelyllä", english: "I went for a walk yesterday" },
  { finnish: "nähdään huomenna", english: "See you tomorrow" },
];

function key(value: string): string {
  return value.trim().toLocaleLowerCase("fi-FI").replace(/[.!?]+$/, "").replace(/\s+/g, " ");
}

export function chooseNewTargets(words: PracticeEvidence[], suggested: NewTarget[] = []): NewTarget[] {
  const known = new Set(words.map((word) => key(word.finnish)));
  const chosen: NewTarget[] = [];
  const add = (candidate: NewTarget) => {
    const finnish = candidate.finnish?.trim();
    const english = candidate.english?.trim();
    if (!finnish || !english || finnish.length > 80 || known.has(key(finnish)) || chosen.some((item) => key(item.finnish) === key(finnish))) return;
    chosen.push({ finnish, english });
  };
  for (const candidate of suggested) {
    add(candidate);
    if (chosen.length === 2) return chosen;
  }
  if (chosen.length) return chosen;
  for (const candidate of FALLBACK_TARGETS) {
    add(candidate);
    if (chosen.length === 2) break;
  }
  return chosen;
}

export function buildLessonPlan(words: PracticeEvidence[], suggested: NewTarget[] = [], reviewOnly = false, now = new Date()) {
  const review = selectReviewWords(words, now);
  const old = review.slice(0, 2).map((word) => word.finnish).join(" + ") || "tidligere udtryk";
  if (reviewOnly) {
    const blocks = [
      `4–6 min: Test ${old} uden at give svaret først; både finsk→dansk og dansk→finsk.`,
      "4–6 min: Kombinér kendte udtryk i en ny kort hverdagssamtale; ret kun konkrete fejl.",
      "4–6 min: Genkald udtryk fra ældre samtaler i nye kontekster og gå videre, når de sidder.",
    ];
    return { nextLesson: blocks[0], upcomingLessons: blocks, newTargets: [] as NewTarget[] };
  }
  const targets = chooseNewTargets(words, suggested);
  if (!targets.length) {
    const blocks = [
      `4–6 min: Højst to korte tjek af ${old}; vælg derefter et nyt, brugbart hverdagsudtryk, som ikke står i ordlisten.`,
      "4–6 min: Brug det nye udtryk i en anden situation og introducér et beslægtet nyt mål.",
      "4–6 min: Bland nye og ældre udtryk i en mini-dialog; gå videre efter tydelig succes.",
    ];
    return { nextLesson: blocks[0], upcomingLessons: blocks, newTargets: [] as NewTarget[] };
  }
  const first = targets[0];
  const second = targets[1];
  const blocks = [
    `4–6 min: Højst to korte tjek af ${old}; lær derefter ${first.finnish} (${first.english}) i begge retninger.`,
    second
      ? `4–6 min: Brug ${first.finnish} i en ny situation; lær så ${second.finnish} (${second.english}) i en mini-dialog.`
      : `4–6 min: Brug ${first.finnish} i en ny situation og lær en naturlig beslægtet variation.`,
    `4–6 min: Genkald ${old} og det nye materiale uden facit først; gå videre til et beslægtet mål, når det lykkes.`,
  ];
  return { nextLesson: blocks[0], upcomingLessons: blocks, newTargets: targets };
}

export function copenhagenDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function nextCorrectDayState(count: number, lastDay: string | null, correct: boolean, now: Date) {
  if (!correct) return { correctDayCount: count, lastCorrectDay: lastDay };
  const day = copenhagenDay(now);
  return { correctDayCount: count + (lastDay === day ? 0 : 1), lastCorrectDay: day };
}

/** Echoing an answer is practice, but cannot establish independent long-term recall. */
export function nextWordScores(mastery: number, correctCount: number, incorrectCount: number,
  result: "correct" | "incorrect" | "introduced", independent: boolean, correctDays: number) {
  if (result === "incorrect") return { mastery: Math.max(0, mastery - 1), correctCount, incorrectCount: incorrectCount + 1 };
  if (result !== "correct") return { mastery, correctCount, incorrectCount };
  const cap = !independent ? 2 : correctDays < 2 ? 3 : 5;
  return { mastery: Math.max(mastery, Math.min(cap, mastery + 1)), correctCount: correctCount + 1, incorrectCount };
}
