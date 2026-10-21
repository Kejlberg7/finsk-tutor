import type { A1Assessment } from "@/lib/a1-test";
import type { ExpressionEvidence } from "./expression-progress";

export type TranscriptLine = {
  speaker: "dig" | "tutor";
  text: string;
  startMs?: number;
  endMs?: number;
};

export type DueWord = {
  finnish: string;
  english: string;
  mastery: number;
  status?: string;
};

export type WordProgress = DueWord & {
  danish: string | null;
  example: string | null;
  correctCount: number;
  incorrectCount: number;
  correctDayCount: number;
  lastFeedback: string | null;
  lastSeenAt: string | null;
  nextReviewAt: string | null;
  evidence?: ExpressionEvidence;
};

export type SessionRecap = {
  progress: string[];
  needsWork: string[];
  nextStep: string;
};

export type LearningSnapshot = {
  memoryReady: boolean;
  level: string;
  currentFocus: string;
  nextLesson: string;
  upcomingLessons: string[];
  reviewOnlyPlanned: boolean;
  dueWords: DueWord[];
  wordProgress: WordProgress[];
  knownWordCount: number;
  masteredWordCount: number;
  a1Test: {
    eligible: boolean;
    passes: number;
    latest: A1Assessment | null;
    latestAt: string | null;
  };
  dueWordCount: number;
  completedSessionCount: number;
  totalPracticeSeconds: number;
  estimatedApiCostUsd: number;
  lastSummary: string | null;
  lastRecap: SessionRecap | null;
};

export type RecentSession = {
  id: number;
  kind: "practice" | "a1_test";
  a1Assessment: A1Assessment | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  estimatedApiCostUsd: number;
  summary: string | null;
  recap: SessionRecap | null;
  status: string;
  closeReason: string | null;
  closeConfirmed: boolean;
  transcript: TranscriptLine[];
};

export type IdeaNote = {
  id: number;
  kind: "idea" | "correction";
  content: string;
  status: "open" | "done";
  createdAt: string;
};
