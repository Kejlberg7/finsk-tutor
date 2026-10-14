export type PracticeStat = {
  id: number;
  startedAt: string;
  durationSeconds: number;
  estimatedCostUsd: number;
  status: string;
  closeReason?: string | null;
  closeConfirmed?: boolean;
};

export type ActivityDay = {
  date: string;
  seconds: number;
  sessions: number;
};

export type PracticeStats = {
  totalSeconds: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  goalDays: number;
  averageSeconds: number;
  longestSessionSeconds: number;
  bestDay: ActivityDay | null;
  heatmap: ActivityDay[];
  recentDays: ActivityDay[];
};

const COPENHAGEN = "Europe/Copenhagen";

export function localDayKey(value: Date | string, timeZone = COPENHAGEN): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDay(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function buildPracticeStats(sessions: PracticeStat[], now = new Date()): PracticeStats {
  const daily = new Map<string, ActivityDay>();
  let totalSeconds = 0;
  let longestSessionSeconds = 0;

  for (const session of sessions) {
    const seconds = Number.isFinite(session.durationSeconds) ? Math.max(0, Math.floor(session.durationSeconds)) : 0;
    const key = localDayKey(session.startedAt);
    const day = daily.get(key) ?? { date: key, seconds: 0, sessions: 0 };
    day.seconds += seconds;
    day.sessions += 1;
    daily.set(key, day);
    totalSeconds += seconds;
    longestSessionSeconds = Math.max(longestSessionSeconds, seconds);
  }

  const today = localDayKey(now);
  const activeDates = [...daily.keys()].sort();
  let longestStreak = 0;
  let run = 0;
  for (let index = 0; index < activeDates.length; index++) {
    run = index && shiftDay(activeDates[index - 1], 1) === activeDates[index] ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  }

  let cursor = daily.has(today) ? today : shiftDay(today, -1);
  let currentStreak = 0;
  while (daily.has(cursor)) {
    currentStreak++;
    cursor = shiftDay(cursor, -1);
  }

  const [year, month, dayOfMonth] = today.split("-").map(Number);
  const mondayOffset = (new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay() + 6) % 7;
  const firstMonday = shiftDay(today, -mondayOffset - 77);
  const heatmap = Array.from({ length: 84 }, (_, index) => {
    const date = shiftDay(firstMonday, index);
    return daily.get(date) ?? { date, seconds: 0, sessions: 0 };
  });
  const recentDays = Array.from({ length: 14 }, (_, index) => {
    const date = shiftDay(today, index - 13);
    return daily.get(date) ?? { date, seconds: 0, sessions: 0 };
  });
  const allDays = [...daily.values()];
  const bestDay = allDays.reduce<ActivityDay | null>(
    (best, day) => !best || day.seconds > best.seconds ? day : best, null,
  );

  return {
    totalSeconds,
    activeDays: daily.size,
    currentStreak,
    longestStreak,
    goalDays: allDays.filter((day) => day.seconds >= 30 * 60).length,
    averageSeconds: sessions.length ? Math.round(totalSeconds / sessions.length) : 0,
    longestSessionSeconds,
    bestDay,
    heatmap,
    recentDays,
  };
}
