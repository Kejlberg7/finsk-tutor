import { parseDiagnosticEvent, type DiagnosticDetails, type DiagnosticEvent } from "./session-diagnostics";

const STORAGE_KEY = "finsk-tutor-diagnostics-v1";
const MAX_QUEUED = 120;
let queue: DiagnosticEvent[] | null = null;
let flushing: Promise<void> | null = null;

function pending(): DiagnosticEvent[] {
  if (queue) return queue;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    queue = Array.isArray(stored) ? stored.map(parseDiagnosticEvent)
      .filter((item): item is DiagnosticEvent => item !== null).slice(-MAX_QUEUED) : [];
  } catch { queue = []; }
  return queue;
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pending())); } catch { /* In-memory queue still works. */ }
}

export function reportSessionDiagnostic(input: {
  attemptId: string; sessionId?: number | null; eventType: string; code?: string | null;
  message?: string | null; details?: DiagnosticDetails | null;
}): void {
  if (typeof window === "undefined") return;
  pending().push({
    id: crypto.randomUUID(), attemptId: input.attemptId, sessionId: input.sessionId ?? null,
    eventType: input.eventType, code: input.code?.slice(0, 120) ?? null,
    message: input.message?.slice(0, 600) ?? null, details: input.details ?? null,
    occurredAt: new Date().toISOString(),
  });
  queue = pending().slice(-MAX_QUEUED);
  persist();
  void flushSessionDiagnostics();
}

/** Retry after offline periods and page reloads; event UUIDs make retry idempotent. */
export function flushSessionDiagnostics(): Promise<void> {
  if (typeof window === "undefined" || !navigator.onLine) return Promise.resolve();
  if (flushing) return flushing;
  flushing = (async () => {
    while (pending().length) {
      const batch = pending().slice(0, 12);
      try {
        const response = await fetch("/api/session/diagnostics", {
          method: "POST", credentials: "same-origin", keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch), signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) break;
        const delivered = new Set(batch.map((event) => event.id));
        queue = pending().filter((event) => !delivered.has(event.id));
        persist();
      } catch { break; }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
