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
};

export type WordProgress = DueWord & {
  danish: string | null;
  example: string | null;
  correctCount: number;
  incorrectCount: number;
  lastFeedback: string | null;
  lastSeenAt: string | null;
  nextReviewAt: string | null;
};

export type LearningSnapshot = {
  memoryReady: boolean;
  level: string;
  currentFocus: string;
  nextLesson: string;
  upcomingLessons: string[];
  dueWords: DueWord[];
  wordProgress: WordProgress[];
  knownWordCount: number;
  masteredWordCount: number;
  dueWordCount: number;
  completedSessionCount: number;
  lastSummary: string | null;
};

export type RecentSession = {
  id: number;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  status: string;
  transcript: TranscriptLine[];
};

export type IdeaNote = {
  id: number;
  kind: "idea" | "correction";
  content: string;
  status: "open" | "done";
  createdAt: string;
};
