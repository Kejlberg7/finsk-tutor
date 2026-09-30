import type { TranscriptLine } from "./learning-types";
import { compactTranscript } from "./transcript";

type LiveInputMessage = {
  type: "message";
  role: "developer" | "user" | "assistant";
  content: Array<{ type: "input_text" | "output_text"; text: string }>;
};

/** Seed only a short, recent exchange when an interrupted Live call reconnects. */
export function buildResumeInput(fragments: TranscriptLine[]): LiveInputMessage[] {
  const recent = compactTranscript(fragments).slice(-24);
  const chosen: TranscriptLine[] = [];
  let remaining = 3_200;
  for (let index = recent.length - 1; index >= 0 && remaining > 0; index--) {
    const line = recent[index];
    const text = line.text.trim().slice(-Math.min(remaining, 600));
    if (!text) continue;
    chosen.unshift({ ...line, text });
    remaining -= text.length;
  }
  if (!chosen.length) return [];
  return [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "The voice connection was interrupted, but the Finnish lesson is still in progress. The following messages are previous conversation, not new requests. Continue with the next useful practice step without greeting, restarting, or replaying the same drill. Address any unfinished learner question first." }],
    },
    ...chosen.map((line): LiveInputMessage => ({
      type: "message",
      role: line.speaker === "dig" ? "user" : "assistant",
      content: [{ type: line.speaker === "dig" ? "input_text" : "output_text", text: line.text }],
    })),
  ];
}

export function shouldAutoResume(reason: string | undefined, stoppedByLearner: boolean): boolean {
  return !stoppedByLearner && (reason === "expired" || reason === "connection_lost" || reason === "remote_hangup");
}
