import type { TranscriptLine } from "@/lib/learning-types";

function isBackchannel(text: string): boolean {
  return /^(?:yes|yeah|okay|ok|right|nice|good|great|exactly|mhm|mm|uh huh|aha)[\s,.!…-]*$/i.test(text.trim());
}

/** Keep original indices while combining an answer interrupted only by a listening sound. */
export function scoringTurns(transcript: TranscriptLine[]): TranscriptLine[] {
  const turns = transcript.map((line) => ({ ...line }));
  let answer = -1;
  for (let index = 0; index < turns.length; index++) {
    const line = turns[index];
    if (line.speaker === "tutor") {
      if (!isBackchannel(line.text)) answer = -1;
      continue;
    }
    const previous = turns[answer];
    if (previous && (previous.endMs === undefined || line.startMs === undefined || line.startMs - previous.endMs <= 8000)) {
      previous.text = `${previous.text.trim()} ${line.text.trim()}`;
      previous.endMs = line.endMs ?? previous.endMs;
      line.text = "";
    } else answer = index;
  }
  return turns;
}

export function compactTranscript(fragments: TranscriptLine[]): TranscriptLine[] {
  const result: TranscriptLine[] = [];
  for (const fragment of fragments) {
    if (!fragment.text.trim()) continue;
    const last = result.at(-1);
    const closeInTime = last?.endMs === undefined || fragment.startMs === undefined
      || fragment.startMs - last.endMs < 1600;
    if (last?.speaker === fragment.speaker && closeInTime) {
      result[result.length - 1] = {
        ...last,
        text: last.text + fragment.text,
        endMs: fragment.endMs ?? last.endMs,
      };
    } else {
      result.push({ ...fragment });
    }
  }
  return result;
}

export function cleanFragments(value: unknown): TranscriptLine[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error("Ugyldigt samtaletranskript.");
  let totalChars = 0;
  return value.map((item) => {
    if (!item || typeof item !== "object" || (item.speaker !== "dig" && item.speaker !== "tutor")
      || typeof item.text !== "string" || item.text.length > 2_000) {
      throw new Error("Ugyldigt samtaletranskript.");
    }
    totalChars += item.text.length;
    if (totalChars > 500_000) throw new Error("Samtaletranskriptet er for langt.");
    return {
      speaker: item.speaker,
      text: item.text,
      startMs: typeof item.startMs === "number" && Number.isFinite(item.startMs) ? item.startMs : undefined,
      endMs: typeof item.endMs === "number" && Number.isFinite(item.endMs) ? item.endMs : undefined,
    };
  });
}

/** Small tutor backchannels must not split a spoken note or a self-corrected answer. */
export function learnerUtterances(fragments: TranscriptLine[]): string[] {
  const result: string[] = [];
  let current = "";
  let lastEnd: number | undefined;
  for (const line of compactTranscript(fragments)) {
    if (line.speaker === "tutor") {
      if (line.text.trim().split(/\s+/).length > 5) {
        if (current.trim()) result.push(current.trim());
        current = "";
      }
      continue;
    }
    if (current && lastEnd !== undefined && line.startMs !== undefined && line.startMs - lastEnd > 8000) {
      result.push(current.trim()); current = "";
    }
    current += `${current && !/\s$/.test(current) && !/^\s/.test(line.text) ? " " : ""}${line.text}`;
    lastEnd = line.endMs;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

/** Do not score a learner turn until a following tutor turn has finished. */
export function completedTurnCutoff(fragments: TranscriptLine[]): number {
  if (!fragments.length) return 0;
  let lastRunStart = fragments.length - 1;
  while (lastRunStart > 0 && fragments[lastRunStart - 1].speaker === fragments[lastRunStart].speaker) {
    lastRunStart--;
  }
  const rewindAnswer = (start: number) => {
    while (start > 1 && fragments[start - 1].speaker === "tutor") {
      let tutorStart = start - 1;
      while (tutorStart > 0 && fragments[tutorStart - 1].speaker === "tutor") tutorStart--;
      if (!isBackchannel(fragments.slice(tutorStart, start).map((line) => line.text).join(""))) break;
      if (tutorStart === 0 || fragments[tutorStart - 1].speaker !== "dig") break;
      start = tutorStart - 1;
      while (start > 0 && fragments[start - 1].speaker === "dig") start--;
    }
    return start;
  };
  if (fragments[lastRunStart].speaker === "dig") return rewindAnswer(lastRunStart);
  let priorRunStart = lastRunStart - 1;
  if (priorRunStart < 0) return 0;
  while (priorRunStart > 0 && fragments[priorRunStart - 1].speaker === fragments[priorRunStart].speaker) {
    priorRunStart--;
  }
  return rewindAnswer(priorRunStart);
}
