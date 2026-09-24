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
  correctCount: number;
  incorrectCount: number;
  lastFeedback: string | null;
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
