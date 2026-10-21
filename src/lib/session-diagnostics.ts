export type DiagnosticDetails = Record<string, string | number | boolean | null>;

export type DiagnosticEvent = {
  id: string;
  attemptId: string;
  sessionId: number | null;
  eventType: string;
  code: string | null;
  message: string | null;
  details: DiagnosticDetails | null;
  occurredAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DETAIL_KEYS = new Set([
  "reason", "phase", "peerState", "iceState", "channelState", "visibility", "online",
  "httpStatus", "responseStatus", "responseId", "clientEventId", "parameter",
  "attempt", "elapsedSeconds", "voiceSeconds", "closeConfirmed", "browser",
  "liveSessionId", "serverEventId", "offsetMs", "transcriptIndex", "lastInputEndMs", "lastOutputEndMs",
  "lastResponseId", "lastErrorCode", "recentEvents", "toolName", "callId", "totalPracticeSeconds",
]);

/** Accept only small, structured diagnostics. Never store SDP, audio, transcripts or raw API events. */
export function parseDiagnosticEvent(input: unknown): DiagnosticEvent | null {
  if (!input || typeof input !== "object") return null;
  const item = input as Record<string, unknown>;
  if (typeof item.id !== "string" || !UUID.test(item.id)
    || typeof item.attemptId !== "string" || !UUID.test(item.attemptId)
    || typeof item.eventType !== "string" || !/^[a-z][a-z0-9_.-]{2,79}$/.test(item.eventType)
    || (item.sessionId !== null && (!Number.isSafeInteger(item.sessionId) || Number(item.sessionId) < 1))) return null;
  if (typeof item.occurredAt !== "string" || !Number.isFinite(Date.parse(item.occurredAt))) return null;
  const age = Math.abs(Date.now() - Date.parse(item.occurredAt));
  if (age > 30 * 24 * 60 * 60 * 1_000) return null;
  if (item.code !== null && (typeof item.code !== "string" || item.code.length > 120)) return null;
  if (item.message !== null && (typeof item.message !== "string" || item.message.length > 600)) return null;
  let details: DiagnosticDetails | null = null;
  if (item.details !== null) {
    if (!item.details || typeof item.details !== "object" || Array.isArray(item.details)) return null;
    details = {};
    for (const [key, value] of Object.entries(item.details)) {
      if (!DETAIL_KEYS.has(key) || Object.keys(details).length >= 12) continue;
      if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) details[key] = value;
      else if (typeof value === "string") details[key] = redactDiagnosticMessage(value.slice(0, 160));
    }
  }
  return {
    id: item.id, attemptId: item.attemptId, sessionId: item.sessionId as number | null,
    eventType: item.eventType, code: item.code as string | null,
    message: item.message === null ? null : redactDiagnosticMessage(item.message as string),
    details, occurredAt: new Date(item.occurredAt).toISOString(),
  };
}

export function redactDiagnosticMessage(message: string): string {
  return message.slice(0, 600)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]");
}

export function closeReasonLabel(reason: string, confirmed: boolean): string {
  if (reason === "content") return "Stoppet af sikkerhedsfilter";
  if (reason === "expired") return "Tidsgrænse nået";
  if (reason === "connection_lost") return confirmed ? "Forbindelsen gik tabt" : "Forbindelsen gik tabt (ikke bekræftet af OpenAI)";
  if (reason === "remote_hangup") return "Forbindelsen blev lukket";
  if (reason === "close_requested") return confirmed ? "Afsluttet af dig" : "Afslutning ikke bekræftet";
  return confirmed ? `Afsluttet: ${reason}` : `Afbrudt: ${reason}`;
}
