import type { TranscriptLine } from "./learning-types";
import { cleanFragments, compactTranscript } from "./transcript";
import type { SessionKind } from "./a1-test";

export const RECOVERY_KEY = "finsk-tutor-recovery-v1";
export type SessionRecovery = { transcript: TranscriptLine[]; elapsedSeconds: number; reason: string; savedAt: number; kind: SessionKind; sessionId: number | null };

export function makeSessionRecovery(transcript: TranscriptLine[], elapsedSeconds: number, reason: string, kind: SessionKind, sessionId: number | null = null): SessionRecovery {
  return { transcript: compactTranscript(transcript).slice(-30).map((line) => ({ speaker: line.speaker, text: line.text.slice(-600) })),
    elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)), reason, kind, savedAt: Date.now(), sessionId };
}

export function parseSessionRecovery(value: string | null, now = Date.now()): SessionRecovery | null {
  try {
    const v = JSON.parse(value ?? "null");
    if (!v || !Number.isFinite(v.savedAt) || now - v.savedAt > 12 * 3600_000 || v.savedAt > now + 60_000
      || !Number.isFinite(v.elapsedSeconds) || v.elapsedSeconds < 0 || v.elapsedSeconds > 24 * 3600
      || !["practice", "a1_test"].includes(v.kind) || typeof v.reason !== "string" || v.reason.length > 100) return null;
    if (v.sessionId != null && (!Number.isSafeInteger(v.sessionId) || v.sessionId < 1)) return null;
    const transcript = cleanFragments(v.transcript);
    if (!transcript.length || transcript.length > 30) return null;
    return { ...v, transcript, sessionId: v.sessionId ?? null };
  } catch { return null; }
}
