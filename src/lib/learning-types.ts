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

export type LearningSnapshot = {
  memoryReady: boolean;
  level: string;
  currentFocus: string;
  nextLesson: string;
  dueWords: DueWord[];
  knownWordCount: number;
  lastSummary: string | null;
};
