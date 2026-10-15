"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { extractIdeaCues } from "@/lib/idea-cue";
import { estimateResponseCostUsd, readResponseTokenUsage } from "@/lib/api-cost";
import { sessionPacingUpdate } from "@/lib/session-pacing";
import { shouldAutoResume } from "@/lib/session-continuity";
import { flushSessionDiagnostics, reportSessionDiagnostic } from "@/lib/session-diagnostics-client";
import type { DiagnosticDetails } from "@/lib/session-diagnostics";
import { closeReasonLabel } from "@/lib/session-diagnostics";
import { formatDuration } from "@/lib/duration";
import { practiceCounts, practiceStage } from "@/lib/learning-plan";
import { A1_TEST_PASSES_REQUIRED, A1_TEST_STRONG_GOAL, type SessionKind } from "@/lib/a1-test";
import type { IdeaNote, LearningSnapshot, RecentSession, TranscriptLine, WordProgress } from "@/lib/learning-types";

const EMPTY_LEARNING: LearningSnapshot = {
  memoryReady: false,
  level: "Ny begynder",
  currentFocus: "Korte hverdagssætninger og tydelig udtale",
  nextLesson: "Hilsner og at præsentere sig selv",
  upcomingLessons: ["Hilsner og at præsentere sig selv"],
  reviewOnlyPlanned: false,
  dueWords: [],
  wordProgress: [],
  knownWordCount: 0,
  masteredWordCount: 0,
  a1Test: { eligible: false, passes: 0, latest: null, latestAt: null },
  dueWordCount: 0,
  completedSessionCount: 0,
  totalPracticeSeconds: 0,
  estimatedApiCostUsd: 0,
  lastSummary: null,
  lastRecap: null,
};

const LANGUAGE_LEVELS = [
  { code: "A0", label: "Helt ny", description: "Lærer de første ord og korte sætninger med støtte.", note: "Appens starttrin" },
  { code: "A1", label: "Begynder", description: "Kan bruge enkle hverdagsudtryk og fortælle basale ting om sig selv.", note: "Grundlæggende bruger" },
  { code: "A2", label: "På vej", description: "Kan klare korte, rutineprægede samtaler om velkendte emner.", note: "Grundlæggende bruger" },
  { code: "B1", label: "Selvstændig", description: "Kan klare de fleste hverdagssamtaler og fortælle sammenhængende om kendte emner.", note: "Selvstændig bruger" },
  { code: "B2", label: "Rutineret", description: "Kan tale mere flydende og forklare synspunkter om mange emner.", note: "Selvstændig bruger" },
  { code: "C1", label: "Avanceret", description: "Kan forstå komplekst sprog og udtrykke sig fleksibelt og nuanceret.", note: "Kompetent bruger" },
  { code: "C2", label: "Meget avanceret", description: "Kan forstå næsten alt og udtrykke selv små betydningsnuancer præcist.", note: "Kompetent bruger" },
] as const;

const A1_CHECK_LABELS = [
  ["introduction", "Præsentere dig selv"],
  ["comprehension", "Forstå enkle spørgsmål"],
  ["interaction", "Spørge og svare"],
  ["everydayTask", "Klare en hverdagssituation"],
] as const;

type LiveEvent = {
  type?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  error?: { message?: string; code?: string; type?: string; param?: string; client_event_id?: string };
  event?: {
    type?: string;
    response?: { id?: unknown; model?: unknown; usage?: unknown; status?: string; status_details?: { reason?: string; error?: { code?: string; message?: string } } };
  };
  usage?: { seconds?: number };
  reason?: string;
};

type WordFilter = "all" | "introduced" | "once" | "practicing" | "secure" | "due";

export default function VoiceConsole() {
  const [status, setStatus] = useState("Klar til en samtale.");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [learning, setLearning] = useState<LearningSnapshot>(EMPTY_LEARNING);
  const [history, setHistory] = useState<RecentSession[]>([]);
  const [ideas, setIdeas] = useState<IdeaNote[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [ideasError, setIdeasError] = useState("");
  const [wordFilter, setWordFilter] = useState<WordFilter>("all");
  const [wordSearch, setWordSearch] = useState("");
  const [progressMessage, setProgressMessage] = useState("Ordstatus opdateres under samtalen.");
  const [ideaMessage, setIdeaMessage] = useState("");
  const [wakeNotice, setWakeNotice] = useState("");
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const rawTranscriptRef = useRef<TranscriptLine[]>([]);
  const pendingUserRef = useRef("");
  const ideaTimerRef = useRef<number | null>(null);
  const ideaTasksRef = useRef<Set<Promise<void>>>(new Set());
  const notedFeedbackRef = useRef<Set<string>>(new Set());
  const checkpointTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const checkpointPromiseRef = useRef<Promise<void> | null>(null);
  const progressCursorRef = useRef(0);
  const appSessionIdRef = useRef<number | null>(null);
  const sessionKindRef = useRef<SessionKind>("practice");
  const attemptIdRef = useRef("");
  const finalisingRef = useRef(false);
  const closeReasonRef = useRef<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const connectionTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const recoveringRef = useRef(false);
  const scheduleReconnectRef = useRef<(resumeTranscript: TranscriptLine[]) => void>(() => undefined);
  const acquireWakeLockRef = useRef<() => Promise<void>>(async () => undefined);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wakeLockRequestRef = useRef<Promise<void> | null>(null);
  const connectedAtRef = useRef(0);
  const lastVoiceUsageSecondsRef = useRef(0);
  const savedVoiceUsageSecondsRef = useRef(0);
  const practiceStartedAtRef = useRef(0);
  const manualStopRef = useRef(false);
  const finishRef = useRef<((reason: string, confirmed?: boolean) => void) | null>(null);
  const unmountedRef = useRef(false);
  const nextGoal = [5, 20, 50, 100, 200].find((goal) => learning.masteredWordCount < goal)
    ?? Math.ceil((learning.masteredWordCount + 1) / 100) * 100;
  const milestonePercent = Math.min(100, Math.round((learning.masteredWordCount / nextGoal) * 100));
  const levelCode = learning.level.match(/\b(A0|A1|A2|B1|B2|C1|C2)\b/i)?.[1]?.toUpperCase();
  const evidence = practiceCounts(learning.wordProgress);
  const wordFilterCounts: Record<WordFilter, number> = {
    all: learning.knownWordCount,
    introduced: evidence.introduced,
    once: evidence.once,
    practicing: evidence.practicing,
    secure: evidence.secure,
    due: learning.dueWordCount,
  };
  const filteredWords = learning.wordProgress.filter((word) => {
    const due = isWordDue(word);
    const matchesFilter = wordFilter === "all" || (wordFilter === "due" && due)
      || (wordFilter !== "due" && practiceStage(word) === wordFilter);
    const query = wordSearch.trim().toLocaleLowerCase("da-DK");
    const matchesSearch = !query || [word.finnish, word.english, word.danish, word.example]
      .some((value) => value?.toLocaleLowerCase("da-DK").includes(query));
    return matchesFilter && matchesSearch;
  });

  function diagnose(eventType: string, code?: string | null, message?: string | null, details?: DiagnosticDetails | null,
    sessionId = appSessionIdRef.current, attemptId = attemptIdRef.current) {
    if (!attemptId) return;
    reportSessionDiagnostic({ attemptId, sessionId, eventType, code, message, details });
  }

  async function refreshHistory() {
    try {
      const response = await fetch("/api/history", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Kunne ikke hente samtaler.");
      if (response.ok) setHistory(await response.json() as RecentSession[]);
      setHistoryError("");
    } catch { setHistoryError("Kunne ikke hente samtaler lige nu."); }
  }

  async function refreshIdeas() {
    try {
      const response = await fetch("/api/ideas", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Kunne ikke hente idéer.");
      if (response.ok) setIdeas(await response.json() as IdeaNote[]);
      setIdeasError("");
    } catch { setIdeasError("Kunne ikke hente idéer lige nu."); }
  }

  async function saveVoiceUsage(seconds: number) {
    const sessionId = appSessionIdRef.current;
    const attemptId = attemptIdRef.current;
    const totalSeconds = Math.floor(seconds);
    if (!sessionId || !Number.isFinite(totalSeconds) || totalSeconds < 0
      || totalSeconds <= savedVoiceUsageSecondsRef.current) return;
    try {
      const response = await fetch("/api/session/usage", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ sessionId, attemptId, seconds: totalSeconds }),
      });
      if (!response.ok) throw new Error(`Kunne ikke gemme API-forbruget (HTTP ${response.status}).`);
      if (appSessionIdRef.current === sessionId) savedVoiceUsageSecondsRef.current = totalSeconds;
    } catch (error) {
      diagnose("app.usage_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : null,
        { phase: "voice", voiceSeconds: totalSeconds }, sessionId, attemptId);
    }
  }

  async function saveResponseUsage(responseUsage: { responseId: string; model: string; usage: unknown }) {
    const sessionId = appSessionIdRef.current;
    const attemptId = attemptIdRef.current;
    const usage = readResponseTokenUsage(responseUsage.usage);
    if (!sessionId || !usage || estimateResponseCostUsd(responseUsage.model, usage) === null) return;
    try {
      const response = await fetch("/api/session/usage", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ sessionId, attemptId, responseUsage }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      diagnose("app.usage_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : null,
        { phase: "response", responseId: responseUsage.responseId }, sessionId, attemptId);
    }
  }

  useEffect(() => {
    unmountedRef.current = false;
    void flushSessionDiagnostics();
    void fetch("/api/learning", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Kunne ikke hente læringsplanen.");
        return response.json() as Promise<LearningSnapshot>;
      })
      .then(setLearning)
      .catch(() => undefined);
    void fetch("/api/history", { cache: "no-store", credentials: "same-origin" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json() as Promise<RecentSession[]>; })
      .then((items) => { setHistory(items); setHistoryError(""); })
      .catch(() => setHistoryError("Kunne ikke hente samtaler lige nu."));
    void fetch("/api/ideas", { cache: "no-store", credentials: "same-origin" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json() as Promise<IdeaNote[]>; })
      .then((items) => { setIdeas(items); setIdeasError(""); })
      .catch(() => setIdeasError("Kunne ikke hente idéer lige nu."));
    const onVisibilityChange = () => {
      if (peerRef.current) diagnose("client.visibility", null, null, {
        visibility: document.visibilityState, online: navigator.onLine,
        peerState: peerRef.current.connectionState, channelState: channelRef.current?.readyState ?? "missing",
      });
      if (document.visibilityState !== "visible" || manualStopRef.current) return;
      if (peerRef.current && peerRef.current.connectionState !== "closed") {
        void acquireWakeLockRef.current();
        if (peerRef.current.connectionState === "failed" || peerRef.current.connectionState === "disconnected"
          || channelRef.current?.readyState === "closed") finishRef.current?.("connection_lost");
      } else if (recoveringRef.current && !reconnectTimerRef.current) {
        scheduleReconnectRef.current([...transcriptRef.current]);
      }
    };
    const onOnline = () => {
      void flushSessionDiagnostics();
      if (recoveringRef.current && !reconnectTimerRef.current) scheduleReconnectRef.current([...transcriptRef.current]);
    };
    const onPageHide = () => {
      if (peerRef.current) diagnose("client.pagehide", null, null, {
        peerState: peerRef.current.connectionState, channelState: channelRef.current?.readyState ?? "missing",
      });
    };
    const onUnhandledError = (event: ErrorEvent) => {
      if (peerRef.current) diagnose("app.unhandled_error", event.error instanceof Error ? event.error.name : "unknown", event.message);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!peerRef.current) return;
      const reason = event.reason;
      diagnose("app.unhandled_rejection", reason instanceof Error ? reason.name : "unknown",
        reason instanceof Error ? reason.message : typeof reason === "string" ? reason : null);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onVisibilityChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("error", onUnhandledError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("error", onUnhandledError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
      if (connectionTimerRef.current) window.clearTimeout(connectionTimerRef.current);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (ideaTimerRef.current) window.clearTimeout(ideaTimerRef.current);
      if (checkpointTimerRef.current) window.clearInterval(checkpointTimerRef.current);
      if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
      unmountedRef.current = true;
      void releaseWakeLock();
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
      peerRef.current?.close();
    };
  }, []);

  useEffect(() => { scheduleReconnectRef.current = scheduleReconnect; });
  useEffect(() => { acquireWakeLockRef.current = acquireWakeLock; });

  async function acquireWakeLock() {
    if (wakeLockRef.current || wakeLockRequestRef.current || document.visibilityState !== "visible"
      || manualStopRef.current || !peerRef.current) return;
    if (!("wakeLock" in navigator)) {
      setWakeNotice("Denne browser kan ikke holde skærmen vågen under samtalen.");
      return;
    }
    const request = (async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (manualStopRef.current || !peerRef.current || document.visibilityState !== "visible") {
          await lock.release();
          return;
        }
        wakeLockRef.current = lock;
        setWakeNotice("");
        lock.addEventListener("release", () => {
          if (wakeLockRef.current === lock) wakeLockRef.current = null;
        });
      } catch (error) {
        diagnose("app.wake_lock_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : null);
        setWakeNotice("Skærmen kunne ikke holdes vågen. Forbindelsen forsøges stadig genoprettet ved afbrydelse.");
      }
    })();
    wakeLockRequestRef.current = request;
    await request;
    if (wakeLockRequestRef.current === request) wakeLockRequestRef.current = null;
  }

  async function releaseWakeLock() {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock) await lock.release().catch(() => undefined);
  }

  function updateTranscript(speaker: TranscriptLine["speaker"], event: LiveEvent) {
    if (!event.delta) return;
    rawTranscriptRef.current.push({ speaker, text: event.delta, startMs: event.start_ms, endMs: event.end_ms });
    const next = appendTranscript(transcriptRef.current, {
      speaker,
      text: event.delta,
      startMs: event.start_ms,
      endMs: event.end_ms,
    });
    transcriptRef.current = next;
    setTranscript(next);
    if (speaker === "dig") {
      pendingUserRef.current += event.delta;
      if (ideaTimerRef.current) window.clearTimeout(ideaTimerRef.current);
      ideaTimerRef.current = window.setTimeout(() => { void flushIdea(); }, 5_000);
    } else if (pendingUserRef.current) {
      if (ideaTimerRef.current) window.clearTimeout(ideaTimerRef.current);
      ideaTimerRef.current = window.setTimeout(() => { void flushIdea(); }, 1_500);
    }
  }

  function flushIdea() {
    if (ideaTimerRef.current) window.clearTimeout(ideaTimerRef.current);
    ideaTimerRef.current = null;
    const utterance = pendingUserRef.current.trim();
    pendingUserRef.current = "";
    const cues = extractIdeaCues(utterance);
    if (!cues.length) return;
    const sessionId = appSessionIdRef.current;
    if (!sessionId) {
      setIdeaMessage("Feedback kunne ikke gemmes, fordi samtalen ikke er forbundet endnu.");
      return;
    }
    cues.forEach((cue, noteIndex) => {
      const key = `${cue.kind}:${cue.content.toLocaleLowerCase("da-DK")}`;
      if (notedFeedbackRef.current.has(key)) return;
      notedFeedbackRef.current.add(key);
      const task = persistIdea(utterance, sessionId, noteIndex, key, cue.explicit);
      ideaTasksRef.current.add(task);
      void task.finally(() => { ideaTasksRef.current.delete(task); });
    });
  }

  async function persistIdea(utterance: string, sessionId: number, noteIndex: number, key: string, explicit: boolean) {
    try {
      const response = await fetch("/api/ideas", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ sessionId, sourceKey: crypto.randomUUID(), utterance, noteIndex }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(payload));
      const note = payload as IdeaNote;
      setIdeas((current) => [note, ...current.filter((item) => item.id !== note.id)]);
      setIdeasError("");
      setIdeaMessage("Feedback gemt til senere.");
      if (explicit && appSessionIdRef.current === sessionId) sendEvent({
        type: "session.commentary.append",
        event_id: `idea_saved_${note.id}`,
        delegation_id: null,
        content: "Your app-feedback note was saved for later. Briefly acknowledge that it is saved, then continue the Finnish lesson.",
      });
    } catch (error) {
      diagnose("app.idea_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : null,
        { httpStatus: error instanceof Error && /^HTTP (\d+)/.test(error.message) ? Number(error.message.match(/^HTTP (\d+)/)?.[1]) : null }, sessionId);
      notedFeedbackRef.current.delete(key);
      setIdeaMessage(error instanceof Error ? `Feedback blev ikke gemt: ${error.message}` : "Feedback blev ikke gemt.");
      if (explicit && appSessionIdRef.current === sessionId) sendEvent({
        type: "session.commentary.append",
        event_id: `idea_failed_${crypto.randomUUID()}`,
        delegation_id: null,
        content: "The app could not save that note. Tell the learner briefly that it was not saved, then continue the lesson.",
      });
    }
  }

  async function toggleIdea(note: IdeaNote) {
    try {
      const response = await fetch("/api/ideas", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: note.id, status: note.status === "open" ? "done" : "open" }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(payload));
      const changed = payload as IdeaNote;
      setIdeas((current) => current.map((item) => item.id === changed.id ? changed : item));
    } catch (error) {
      setIdeaMessage(error instanceof Error ? error.message : "Kunne ikke opdatere noten.");
    }
  }

  async function checkpoint() {
    if (sessionKindRef.current === "a1_test") return;
    const sessionId = appSessionIdRef.current;
    const attemptId = attemptIdRef.current;
    if (!sessionId || checkpointPromiseRef.current || rawTranscriptRef.current.length <= progressCursorRef.current) return;
    const fragments = [...rawTranscriptRef.current];
    const task = (async () => {
      try {
        setProgressMessage("Gemmer ordstatus…");
        const response = await fetch("/api/session/progress", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(55_000),
          body: JSON.stringify({ sessionId, attemptId, fragments }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(apiErrorMessage(payload));
        const result = payload as {
          learning: LearningSnapshot; progressCursor: number; correctWords: string[];
          difficultWords: string[];
        };
        if (appSessionIdRef.current !== sessionId) return;
        const advanced = result.progressCursor > progressCursorRef.current;
        progressCursorRef.current = result.progressCursor;
        setLearning(result.learning);
        setProgressMessage(advanced
          ? `Ordstatus gemt kl. ${new Intl.DateTimeFormat("da-DK", { hour: "2-digit", minute: "2-digit" }).format(new Date())}.`
          : "Venter på en afsluttet øvelse før næste opdatering.");
        if (advanced) {
          const elapsedSeconds = practiceStartedAtRef.current
            ? Math.floor((Date.now() - practiceStartedAtRef.current) / 1_000)
            : 0;
          sendEvent({
            type: "session.thinking.append",
            event_id: `progress_${result.progressCursor}`,
            delegation_id: null,
            content: `Background learning state, not an instruction to pause: successful items ${result.correctWords.join(", ") || "none"}; items needing another attempt ${result.difficultWords.join(", ") || "none"}. Do not repeat successful drills. ${result.learning.reviewOnlyPlanned ? "Continue the explicitly planned review-only session with varied prompts; no new material." : "Move to a new connected target after at most one brief older-phrase check, unless the learner explicitly requested review only for this session."} ${sessionPacingUpdate(elapsedSeconds)} Keep the current conversation flowing.`,
          });
        }
        void refreshHistory();
      } catch (error) {
        diagnose("app.checkpoint_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : null,
          { phase: "progress" }, sessionId, attemptId);
        if (appSessionIdRef.current === sessionId) setProgressMessage(error instanceof Error ? `Ordstatus kunne ikke gemmes endnu: ${error.message}` : "Ordstatus kunne ikke gemmes endnu.");
      }
    })();
    checkpointPromiseRef.current = task;
    await task;
    if (checkpointPromiseRef.current === task) checkpointPromiseRef.current = null;
  }

  function closeConnection() {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    if (connectionTimerRef.current) window.clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = null;
    if (checkpointTimerRef.current) window.clearInterval(checkpointTimerRef.current);
    checkpointTimerRef.current = null;
    if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = null;
    void releaseWakeLock();
    setWakeNotice("");
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    channelRef.current?.close();
    peerRef.current?.close();
    microphoneRef.current = null;
    channelRef.current = null;
    peerRef.current = null;
    finishRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setActive(false);
    setConnecting(false);
  }

  function scheduleReconnect(resumeTranscript: TranscriptLine[]) {
    if (manualStopRef.current || unmountedRef.current || reconnectTimerRef.current || peerRef.current) return;
    recoveringRef.current = true;
    if (reconnectAttemptsRef.current >= 8) {
      diagnose("client.reconnect_exhausted", "max_attempts", null, { attempt: reconnectAttemptsRef.current });
      setConnecting(false);
      setStatus("Forbindelsen blev afbrudt. Automatisk genoprettelse mislykkedes — genoptag, når det er sikkert.");
      return;
    }
    if (!navigator.onLine) {
      setConnecting(true);
      setStatus("Netværket er væk. Samtalen genoptages automatisk, når forbindelsen er tilbage.");
      return;
    }
    const attempt = ++reconnectAttemptsRef.current;
    diagnose("client.reconnect_scheduled", null, null, { attempt, online: navigator.onLine });
    setConnecting(true);
    setStatus("Forbindelsen blev afbrudt. Genoptager samtalen automatisk…");
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void start(resumeTranscript, true);
    }, Math.min(1_000 * 2 ** (attempt - 1), 12_000));
  }

  async function start(resumeTranscript: TranscriptLine[] = [], automatic = false, requestedKind: SessionKind = "practice") {
    if (!automatic) sessionKindRef.current = requestedKind;
    const kind = sessionKindRef.current;
    const attemptId = crypto.randomUUID();
    attemptIdRef.current = attemptId;
    diagnose("client.start", automatic ? "automatic_resume" : "manual_start", null, {
      online: navigator.onLine, visibility: document.visibilityState, browser: navigator.userAgent.slice(0, 160),
    }, null);
    if (!automatic) {
      manualStopRef.current = false;
      recoveringRef.current = false;
      reconnectAttemptsRef.current = 0;
      practiceStartedAtRef.current = 0;
      lastVoiceUsageSecondsRef.current = 0;
      savedVoiceUsageSecondsRef.current = 0;
      notedFeedbackRef.current.clear();
      setTranscript([]);
      transcriptRef.current = [];
    }
    closeReasonRef.current = null;
    setStatus(automatic ? "Genoptager samtalen…" : "Forbinder…");
    setConnecting(true);
    rawTranscriptRef.current = [];
    pendingUserRef.current = "";
    progressCursorRef.current = 0;
    checkpointPromiseRef.current = null;
    if (!automatic) setIdeaMessage("");
    setProgressMessage("Ordstatus opdateres cirka hvert 3. minut efter afsluttede øvelser.");
    appSessionIdRef.current = null;
    finalisingRef.current = false;
    if (!automatic) setSaving(false);

    let finished = false;
    let phase = "peer_creation";
    try {
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      peer.ontrack = (event) => {
        if (!audioRef.current) return;
        audioRef.current.srcObject = new MediaStream([event.track]);
        void audioRef.current.play().catch((error) => {
          diagnose("media.playback_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : null);
          setStatus("Tryk på afspilningsknappen for at høre tutorens stemme.");
        });
      };

      phase = "microphone";
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneRef.current = microphone;
      microphone.getAudioTracks().forEach((track) => {
        peer.addTrack(track, microphone);
        track.onended = () => { if (!finished) diagnose("media.track_ended", "microphone_ended", null, { peerState: peer.connectionState }); };
        track.onmute = () => { if (!finished) diagnose("media.track_muted", "microphone_muted", null, { peerState: peer.connectionState }); };
      });

      phase = "data_channel";
      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      const finish = (reason: string, confirmed = false) => {
        if (finished || unmountedRef.current) return;
        finished = true;
        closeReasonRef.current = reason;
        diagnose("client.finish", reason, null, {
          reason, closeConfirmed: confirmed, peerState: peer.connectionState,
          iceState: peer.iceConnectionState, channelState: channel.readyState,
          elapsedSeconds: connectedAtRef.current ? Math.max(0, Math.round((Date.now() - connectedAtRef.current) / 1_000)) : 0,
        });
        void flushIdea();
        const context = transcriptRef.current.length ? [...transcriptRef.current] : resumeTranscript;
        const recover = shouldAutoResume(reason, manualStopRef.current);
        if (recover && Date.now() - connectedAtRef.current > 60_000) reconnectAttemptsRef.current = 0;
        const usageSave = saveVoiceUsage(lastVoiceUsageSecondsRef.current);
        void saveSession(recover, usageSave);
        closeConnection();
        if (recover) scheduleReconnect(context);
        else {
          recoveringRef.current = false;
          if (!manualStopRef.current && reason !== "close_requested") {
            setStatus(reason === "content" ? "Samtalen blev stoppet af sikkerhedshensyn." : "Samtalen blev afbrudt.");
          }
        }
      };
      finishRef.current = finish;
      channel.onopen = () => diagnose("transport.channel_state", "open", null, { channelState: channel.readyState });
      channel.onerror = () => diagnose("transport.channel_state", "error", null, {
        channelState: channel.readyState, peerState: peer.connectionState,
      });
      channel.onclose = () => {
        if (!finished) diagnose("transport.channel_state", "closed", null, {
          channelState: channel.readyState, peerState: peer.connectionState,
        });
        if (!finished && !connectionTimerRef.current) {
          connectionTimerRef.current = window.setTimeout(() => finish("connection_lost"), 1_500);
        }
      };
      peer.onconnectionstatechange = () => {
        if (!finished) diagnose("transport.peer_state", peer.connectionState, null, {
          peerState: peer.connectionState, iceState: peer.iceConnectionState, channelState: channel.readyState,
          online: navigator.onLine, visibility: document.visibilityState,
        });
        if (peer.connectionState === "connected" && channel.readyState === "open" && connectionTimerRef.current) {
          window.clearTimeout(connectionTimerRef.current);
          connectionTimerRef.current = null;
        }
        if (["failed", "disconnected", "closed"].includes(peer.connectionState) && !finished && !connectionTimerRef.current) {
          connectionTimerRef.current = window.setTimeout(() => finish("connection_lost"), peer.connectionState === "disconnected" ? 7_000 : 1_500);
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (!finished && ["disconnected", "failed", "closed"].includes(peer.iceConnectionState)) {
          diagnose("transport.ice_state", peer.iceConnectionState, null, { peerState: peer.connectionState });
        }
      };
      channel.onmessage = (message) => {
        const event = safeLiveEvent(message.data);
        if (!event) return;
        if (event.type === "session.started") {
          diagnose("live.session_started", null, null, { peerState: peer.connectionState, channelState: channel.readyState });
          recoveringRef.current = false;
          reconnectAttemptsRef.current = 0;
          setStatus(kind === "a1_test" ? "A1-taletest i gang — tal bare." : "Forbundet — tal bare.");
          sendEvent({
            type: "session.instructions.append",
            event_id: automatic ? "resume_conversation" : kind === "a1_test" ? "start_a1_test" : "start_lesson",
            delegation_id: null,
            content: automatic
              ? kind === "a1_test" ? "The previous A1 check was interrupted and cannot be combined with this new call. Briefly tell the learner that you are restarting the four short test tasks, then begin the test from the start. Do not switch to a normal lesson." : "Continue the interrupted Finnish lesson now, without a greeting or repeated review. Use the supplied conversation history and teach the next useful step."
              : kind === "a1_test" ? "Begin the internal oral A1 check now. Briefly explain in English, then ask the first test question. Do not coach or reveal answers before attempts." : "Open the lesson now with a very brief English greeting and today's focus, then give the first short Finnish phrase. Normally mix brief review with small new targets; honor any review-only preference in the learner memory.",
          });
        }
        if (event.type === "session.delegation.created") {
          setStatus("Planlægger næste øvelse — du kan stadig tale.");
        }
        if (event.type === "response.event" && ["response.completed", "response.failed", "response.incomplete"].includes(event.event?.type ?? "")) {
          setStatus(kind === "a1_test" ? "A1-taletest i gang — tal bare." : "Forbundet — tal bare.");
        }
        if (event.type === "response.event" && ["response.failed", "response.incomplete"].includes(event.event?.type ?? "")) {
          const problem = event.event?.response;
          diagnose("live.response_problem", event.event?.type ?? "unknown", problem?.status_details?.error?.message ?? null, {
            responseId: typeof problem?.id === "string" ? problem.id : "unknown",
            responseStatus: problem?.status ?? "unknown", reason: problem?.status_details?.reason ?? "unknown",
          });
        }
        const completedResponse = event.event?.response;
        if (event.type === "response.event" && event.event?.type === "response.completed"
          && typeof completedResponse?.id === "string" && typeof completedResponse.model === "string") {
          void saveResponseUsage({ responseId: completedResponse.id, model: completedResponse.model, usage: completedResponse.usage });
        }
        if (event.type === "session.usage.updated" && typeof event.usage?.seconds === "number") {
          lastVoiceUsageSecondsRef.current = Math.max(lastVoiceUsageSecondsRef.current, event.usage.seconds);
          if (lastVoiceUsageSecondsRef.current - savedVoiceUsageSecondsRef.current >= 60) {
            void saveVoiceUsage(lastVoiceUsageSecondsRef.current);
          }
        }
        if (event.type === "session.closed") {
          if (typeof event.usage?.seconds === "number") lastVoiceUsageSecondsRef.current = Math.max(lastVoiceUsageSecondsRef.current, event.usage.seconds);
          diagnose("live.session_closed", event.reason ?? "unknown", null, {
            reason: event.reason ?? "unknown", voiceSeconds: event.usage?.seconds ?? null,
            peerState: peer.connectionState, channelState: channel.readyState,
          });
          finish(event.reason ?? "connection_lost", true);
        }
        if (event.type === "session.input_transcript.delta") updateTranscript("dig", event);
        if (event.type === "session.output_transcript.delta") updateTranscript("tutor", event);
        if (event.type === "error") {
          diagnose("live.error", event.error?.code ?? event.error?.type ?? "unknown", event.error?.message ?? null, {
            parameter: event.error?.param ?? null, clientEventId: event.error?.client_event_id ?? null,
          });
          if (event.error?.message) setStatus(event.error.message);
        }
      };

      phase = "offer";
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer);
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Mangler lokal WebRTC-beskrivelse.");

      phase = "session_api";
      const response = await fetch("/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp, attemptId, kind,
          ...(automatic ? { resumeTranscript: resumeTranscript.slice(-30).map((line) => ({ speaker: line.speaker, text: line.text.slice(-600) })) } : {}),
        }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(`${apiErrorMessage(payload)} (HTTP ${response.status})`);
      }
      const result = await response.json() as {
        transport?: { sdp?: string };
        app_session_id?: number | null;
        learning?: LearningSnapshot;
      };
      if (!result.transport?.sdp) throw new Error("OpenAI returnerede ikke et SDP-svar.");
      if (manualStopRef.current || unmountedRef.current) throw new Error("Samtalen blev afbrudt under opstart.");
      appSessionIdRef.current = result.app_session_id ?? null;
      diagnose("client.session_created", null, null, { httpStatus: response.status, online: navigator.onLine });
      lastVoiceUsageSecondsRef.current = 0;
      savedVoiceUsageSecondsRef.current = 0;
      if (result.learning) setLearning(result.learning);
      phase = "remote_description";
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      connectedAtRef.current = Date.now();
      if (!practiceStartedAtRef.current) practiceStartedAtRef.current = connectedAtRef.current;
      setActive(true);
      setConnecting(false);
      void acquireWakeLock();
      checkpointTimerRef.current = window.setInterval(() => { void checkpoint(); }, 150_000);
      heartbeatTimerRef.current = window.setInterval(() => diagnose("client.heartbeat", null, null, {
        peerState: peer.connectionState, iceState: peer.iceConnectionState,
        channelState: channel.readyState, online: navigator.onLine, visibility: document.visibilityState,
        elapsedSeconds: Math.round((Date.now() - connectedAtRef.current) / 1_000),
      }), 60_000);
    } catch (error) {
      diagnose("client.start_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : null, {
        phase, online: navigator.onLine, peerState: peerRef.current?.connectionState ?? "missing",
      });
      finished = true;
      closeConnection();
      if (automatic && !manualStopRef.current) scheduleReconnect(resumeTranscript);
      else if (!manualStopRef.current) setStatus(error instanceof Error ? error.message : "Kunne ikke starte samtalen.");
    }
  }

  function stop() {
    manualStopRef.current = true;
    recoveringRef.current = false;
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    setStatus("Afslutter og gemmer samtalen…");
    void flushIdea();
    if (channelRef.current?.readyState === "open") {
      diagnose("client.close_requested", null, null, { channelState: channelRef.current.readyState });
      sendEvent({ type: "session.close" });
      closeTimerRef.current = window.setTimeout(() => {
        diagnose("client.close_timeout", "no_session_closed", null, { elapsedSeconds: 8 });
        finishRef.current?.("close_requested");
      }, 8_000);
      return;
    }
    if (finishRef.current) finishRef.current("close_requested");
    else {
      closeConnection();
      setStatus("Samtalen er stoppet.");
    }
  }

  function sendEvent(event: Record<string, unknown>) {
    if (channelRef.current?.readyState === "open") channelRef.current.send(JSON.stringify(event));
  }

  async function saveSession(background = false, voiceUsageSave?: Promise<void>) {
    if (finalisingRef.current) return;
    finalisingRef.current = true;
    if (!background) setSaving(true);
    const sessionId = appSessionIdRef.current;
    const attemptId = attemptIdRef.current;
    const kind = sessionKindRef.current;
    const closeReason = closeReasonRef.current;
    const finalTranscript = [...rawTranscriptRef.current];
    const pendingCheckpoint = checkpointPromiseRef.current;
    const pendingIdeas = [...ideaTasksRef.current];
    if (voiceUsageSave) await voiceUsageSave;
    if (pendingCheckpoint) await pendingCheckpoint;
    await Promise.all(pendingIdeas);

    if (!sessionId) {
      if (!background) { setStatus("Samtalen er afsluttet. Hukommelsen er ikke sat op endnu."); setSaving(false); }
      return;
    }
    if (!finalTranscript.some((line) => line.text.trim())) {
      if (!background) { setStatus("Samtalen er afsluttet, men der var intet transkript at gemme."); setSaving(false); }
      return;
    }

    if (!background) setStatus(kind === "a1_test" ? "A1-taletesten vurderes…" : "Samtalen analyseres og føjes til din læringsplan…");
    try {
      const response = await fetch("/api/session/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(65_000),
        body: JSON.stringify({ sessionId, attemptId, transcript: finalTranscript,
          interrupted: kind === "a1_test" && (background || ["content", "connection_lost", "expired"].includes(closeReason ?? "")) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(payload));
      const nextLearning = (payload as { learning?: LearningSnapshot } | null)?.learning;
      if (nextLearning && (appSessionIdRef.current === sessionId || !background)) setLearning(nextLearning);
      void refreshHistory();
      void refreshIdeas();
      if (!background) setStatus(closeReason === "content"
        ? "Samtalen blev stoppet af sikkerhedshensyn, men er gemt."
        : kind === "a1_test"
          ? "A1-taletesten er gemt. Se vurderingen nedenfor."
          : "Gemt — næste samtale fortsætter ud fra det, du øvede.");
    } catch (error) {
      diagnose("app.save_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : null,
        { phase: "complete" }, sessionId, attemptId);
      if (background) setProgressMessage(error instanceof Error ? `En afbrudt samtaledel blev ikke gemt: ${error.message}` : "En afbrudt samtaledel blev ikke gemt.");
      else setStatus(error instanceof Error ? `Samtalen sluttede, men blev ikke gemt: ${error.message}` : "Samtalen sluttede, men blev ikke gemt.");
    } finally {
      if (!background) setSaving(false);
    }
  }

  return (
    <main className="shell">
      <div className="app-frame">
        <header className="topbar">
          <div className="brand"><span className="flag-mark" aria-hidden="true" /><div><strong>Finsk Tutor</strong><small>Din sprogrejse</small></div></div>
          <span className={learning.memoryReady ? "memory ready" : "memory"}>
            <span aria-hidden="true" />{learning.memoryReady ? "Hukommelse aktiv" : "Hukommelse mangler"}
          </span>
        </header>

        <section className="hero-card" aria-labelledby="welcome-title">
          <div className="hero-orbit hero-orbit-one" aria-hidden="true" />
          <div className="hero-orbit hero-orbit-two" aria-hidden="true" />
          <div className="hero-content">
            <div className="hero-eyebrow"><span aria-hidden="true">✦</span> DIN PERSONLIGE FINSKLEKTION</div>
            <h1 id="welcome-title">Puhu rohkeasti.<span>Tal med mod.</span></h1>
            <p>En rolig samtale, der husker dine ord og tager dig videre i dit eget tempo. Du kan tale dansk; tutoren forklarer på engelsk.</p>
            <div className="hero-actions">
              <button className="primary" type="button" onClick={() => {
                if (recoveringRef.current) {
                  reconnectAttemptsRef.current = 0;
                  void start([...transcriptRef.current], true);
                } else void start();
              }} disabled={active || connecting || saving}>
                <span className="play-symbol" aria-hidden="true">▶</span>{connecting ? "Forbinder…" : recoveringRef.current ? "Genoptag samtale" : "Start samtale"}
              </button>
              <button className="danger" type="button" onClick={stop} disabled={!active && !connecting}>Stop og gem</button>
              <Link className="secondary stats-entry" href="/statistik">Se din statistik <span aria-hidden="true">↗</span></Link>
            </div>
            <div className="session-status" role="status"><span className={active ? "status-light active" : "status-light"} aria-hidden="true" />{status}</div>
            <div className="live-progress" role="status">{progressMessage}</div>
            {wakeNotice && <div className="live-progress" role="status">{wakeNotice}</div>}
          </div>
        </section>

        <div className="audio-row"><span>Lyd fra tutoren</span><audio ref={audioRef} autoPlay controls /></div>

        <section className="dashboard" aria-labelledby="dashboard-title">
          <div className="section-heading"><div><span className="section-kicker">DIT OVERBLIK</span><h2 id="dashboard-title">Sådan går det med din finsk</h2></div><span className="level-chip">{learning.level}</span></div>

          <div className="dashboard-main">
            <section className="milestone-card" aria-label="Din næste milepæl">
              <div className="milestone-copy">
                <span className="card-kicker">NÆSTE MILEPÆL</span>
                <h3>{nextGoal} stærke udtryk</h3>
                <p>“Sikker” er tutorens øvescore – ikke et bevis for, at udtrykket er klaret på flere forskellige dage.</p>
                <div className="milestone-count"><strong>{learning.masteredWordCount}</strong><span>af {nextGoal} udtryk</span></div>
              </div>
              <div className="milestone-ring" role="progressbar" aria-label="Fremskridt mod næste milepæl for stærke udtryk" aria-valuenow={learning.masteredWordCount} aria-valuemin={0} aria-valuemax={nextGoal} style={{ background: `conic-gradient(var(--lime) ${milestonePercent}%, #335e50 ${milestonePercent}% 100%)` }}>
                <div><strong>{milestonePercent}%</strong><span>på vej</span></div>
              </div>
            </section>

            <section className="lesson-card" aria-label="Din læringsplan">
              <span className="card-kicker">DIN PLAN · KAN ÆNDRE SIG</span>
              <h3>De næste øveblokke</h3>
              <p className="lesson-focus"><strong>Fokus lige nu:</strong> {learning.currentFocus}</p>
              <ol className="lesson-list">
                {learning.upcomingLessons.map((lesson, index) => (
                  <li className="lesson-item" key={`${index}-${lesson}`}>
                    <span className="lesson-icon" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    <div><span className="label">{index === 0 ? "Næste blok" : "Derefter"}</span><p>{lesson}</p></div>
                  </li>
                ))}
              </ol>
              <p className="lesson-note">Planen bruger få udvalgte repetitionsmål og nye udtryk. Den opdateres efter gemte samtaler, og tutoren kan tilpasse den undervejs.</p>
            </section>
          </div>

          <section className="level-guide" aria-labelledby="level-guide-title">
            <div className="level-guide-heading">
              <div>
                <span className="card-kicker">NIVEAUSTIGEN</span>
                <h3 id="level-guide-title">Alle sprogniveauer</h3>
                <p>En guide til rejsen fra de første ord til avanceret finsk.</p>
              </div>
              <span className="level-guide-current">Dit niveau: {levelCode ?? "Afventer"}</span>
            </div>
            <ol className="level-guide-list">
              {LANGUAGE_LEVELS.map((level) => {
                const current = level.code === levelCode;
                return (
                  <li className={current ? "level-step current" : "level-step"} key={level.code} aria-current={current ? "step" : undefined}>
                    <div className="level-step-top"><strong>{level.code}</strong><span>{level.note}</span></div>
                    <h4>{level.label}</h4>
                    <p>{level.description}</p>
                    {current ? <span className="level-step-marker">DIT NIVEAU</span> : null}
                  </li>
                );
              })}
            </ol>
            <p className="level-guide-note">A0 er appens starttrin. Mundtligt A1 markeres først efter to beståede, særskilte taletests. Det er en intern vurdering af tale og lytning, ikke et officielt CEFR-bevis. A2–C2 er foreløbige læringsmål; deres tests er ikke bygget endnu.</p>
            <Link className="level-guide-link" href="/statistik#langsigtede-maal">Se konkrete mål for A2–C2 ↗</Link><br />
            <a className="level-guide-link" href="https://www.coe.int/en/web/common-european-framework-reference%2Blanguages/table-1-cefr-3.3-common-reference-levels-global-scale" target="_blank" rel="noreferrer">Læs om CEFR hos Europarådet ↗</a>
          </section>

          <section className="a1-check-card" aria-labelledby="a1-check-title">
            <div>
              <span className="card-kicker">MUNDTLIG A1-VURDERING</span>
              <h3 id="a1-check-title">{learning.a1Test.passes >= A1_TEST_PASSES_REQUIRED ? "A1 i tale og lytning · appvurderet" : "Din vej til A1-taletesten"}</h3>
              <p>{learning.a1Test.eligible
                ? `Testen er åben. Du har ${Math.min(learning.a1Test.passes, A1_TEST_PASSES_REQUIRED)} af ${A1_TEST_PASSES_REQUIRED} beståede tests i forskellige samtaler.`
                : `${learning.masteredWordCount} af ${A1_TEST_STRONG_GOAL} stærke udtryk. Ved cirka 100 åbner en kort, håndfri test af forståelse og samtale.`}</p>
              <p className="a1-check-disclaimer">Testen varer cirka 10–15 minutter. Den giver ikke et officielt CEFR-certifikat og vurderer ikke læsning eller skrivning.</p>
              {learning.a1Test.latest && <div className="a1-check-result">
                <strong>Seneste test: {learning.a1Test.latest.outcome === "passed" ? "Bestået" : learning.a1Test.latest.outcome === "incomplete" ? "Ikke vurderbar" : "Øv lidt mere"}</strong>
                <p>{learning.a1Test.latest.summary}</p>
                {learning.a1Test.latest.outcome !== "incomplete" && <ul className="a1-check-list">
                  {A1_CHECK_LABELS.map(([key, label]) => <li key={key}><span aria-hidden="true">{learning.a1Test.latest?.checks[key] ? "✓" : "○"}</span>{label}</li>)}
                </ul>}
                {learning.a1Test.latest.needsWork.length > 0 && <small>Øv videre: {learning.a1Test.latest.needsWork.join(" · ")}</small>}
              </div>}
            </div>
            {learning.a1Test.eligible && <button type="button" className="a1-check-start" disabled={active || connecting || saving}
              onClick={() => { void start([], false, "a1_test"); }}>Start A1-taletest <span aria-hidden="true">↗</span></button>}
          </section>

          <div className="stat-grid" aria-label="Dine øvestatistikker">
            <div className="stat-card"><span className="stat-icon green" aria-hidden="true">✧</span><strong>{learning.knownWordCount}</strong><span>Ord og udtryk mødt</span></div>
            <div className="stat-card"><span className="stat-icon peach" aria-hidden="true">·</span><strong>{evidence.introduced + evidence.once}</strong><span>Kun nævnt / ét forsøg</span></div>
            <div className="stat-card"><span className="stat-icon blue" aria-hidden="true">↗</span><strong>{evidence.practicing + evidence.secure}</strong><span>Øvet flere gange</span></div>
            <div className="stat-card"><span className="stat-icon lime" aria-hidden="true">✓</span><strong>{learning.masteredWordCount}</strong><span>Sikre efter score</span></div>
            <div className="stat-card"><span className="stat-icon peach" aria-hidden="true">↺</span><strong>{learning.dueWordCount}</strong><span>Klar til repetition</span></div>
            <div className="stat-card"><span className="stat-icon blue" aria-hidden="true">◉</span><strong>{learning.completedSessionCount}</strong><span>Gemte samtaler</span></div>
            <div className="stat-card time-stat"><span className="stat-icon blue" aria-hidden="true">◷</span><strong>{formatDuration(learning.totalPracticeSeconds)}</strong><span>Samlet samtaletid</span><small>Beregnet fra gemte øveture</small></div>
            <div className="stat-card time-stat"><span className="stat-icon peach" aria-hidden="true">$</span><strong>{formatUsd(learning.estimatedApiCostUsd)}</strong><span>Estimeret API-forbrug</span><small>GPT-Live-tale estimeret · baggrundskald målt fra nu</small></div>
          </div>

          <div className="detail-grid">
            <section className="review-card">
              <div className="detail-heading"><div><span className="card-kicker">KOMMER IGEN</span><h3>Udvalgt til repetition</h3></div><span className="detail-count">{learning.dueWordCount} klar</span></div>
              {learning.dueWords.length ? (
                <div className="review-words" aria-label="Ord til repetition">
                  {learning.dueWords.map((word) => <span key={word.finnish} lang="fi">{word.finnish}</span>)}
                </div>
              ) : <p className="empty-copy">Ingen egnede udtryk er udvalgt til kort repetition lige nu.</p>}
              <p className="review-selection-note">Vi tager højst fem varierede udtryk ad gangen – ikke hele køen i én samtale.</p>
            </section>
            <section className="recent-card">
              <span className="card-kicker">SIDSTE SAMTALE</span>
              <h3>Det tog du med dig</h3>
              <p>{learning.lastSummary ?? "Efter din første gemte samtale får du en kort opsummering her."}</p>
              {learning.lastRecap ? <div className="recap-details">
                {learning.lastRecap.progress.length > 0 && <p><strong>Det lykkedes:</strong> {learning.lastRecap.progress.join(" · ")}</p>}
                {learning.lastRecap.needsWork.length > 0 && <p><strong>Øv videre:</strong> {learning.lastRecap.needsWork.join(" · ")}</p>}
                {learning.lastRecap.nextStep && <p><strong>Næste skridt:</strong> {learning.lastRecap.nextStep}</p>}
              </div> : null}
            </section>
          </div>

          <details className="word-progress">
            <summary><span><span className="card-kicker">ORD FOR ORD</span><strong>Ord og udtryk · {learning.knownWordCount} mødt</strong><small>Se hvad der kun er nævnt, og hvad du faktisk har øvet</small></span><span className="details-arrow" aria-hidden="true">↗</span></summary>
            <p className="word-progress-note">Én vurdering er ikke det samme som sikker beherskelse. “Sikker” er en øvescore på 4–5/5; antal korrekte dage registreres fra denne opdatering og kan ikke genskabes sikkert fra gamle samtaler. En post kan være et ord eller en hel frase.</p>
            {learning.wordProgress?.length ? (
              <>
                <div className="word-progress-controls">
                  <div className="word-filter-list" role="group" aria-label="Filtrér ord efter status">
                    {([
                      ["all", "Alle mødt"],
                      ["introduced", "Kun nævnt"],
                      ["once", "Ét forsøg"],
                      ["practicing", "Øvet flere gange"],
                      ["secure", "Sikre efter score"],
                      ["due", "Klar til repetition"],
                    ] as const).map(([filter, label]) => (
                      <button className={wordFilter === filter ? "word-filter active" : "word-filter"} type="button" key={filter} aria-pressed={wordFilter === filter} onClick={() => setWordFilter(filter)}>
                        {label} <span>{wordFilterCounts[filter]}</span>
                      </button>
                    ))}
                  </div>
                  <label className="word-search-label">Find et ord
                    <input type="search" value={wordSearch} onChange={(event) => setWordSearch(event.target.value)} placeholder="Finsk eller dansk/engelsk" />
                  </label>
                </div>
                {filteredWords.length ? <ul>
                {filteredWords.map((word) => (
                  <li key={word.finnish}>
                    <div className="word-progress-heading"><div><strong lang="fi">{word.finnish}</strong><span>{word.danish || word.english}</span>{word.danish && word.english && word.danish !== word.english ? <small className="word-english">Engelsk: {word.english}</small> : null}</div><strong>{word.mastery * 20}%</strong></div>
                    <div className="progress-track" role="progressbar" aria-label={`Øveniveau for ${word.finnish}`} aria-valuenow={word.mastery * 20} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${word.mastery * 20}%` }} /></div>
                    <div className="word-status-list">
                      <span className={practiceStage(word) === "secure" ? "word-status secure" : "word-status learning"}>{wordStageLabel(word)}</span>
                      {isWordDue(word) ? <span className="word-status due">Klar til repetition</span> : null}
                      {word.mastery >= 4 && word.correctDayCount >= 2 ? <span className="word-status secure">Korrekt på flere dage</span> : null}
                    </div>
                    <small>{word.correctCount} rigtige · {word.incorrectCount} rettet{word.lastSeenAt ? ` · ${word.correctCount + word.incorrectCount === 0 ? "Nævnt" : "Vurderet"} ${formatShortDate(word.lastSeenAt)}` : ""}{word.correctDayCount > 0 ? ` · ${word.correctDayCount} korrekt${word.correctDayCount === 1 ? " dag" : "e dage"} registreret fremover` : ""}</small>
                    {!isWordDue(word) && word.nextReviewAt ? <small className="word-next-review">Næste repetition {formatShortDate(word.nextReviewAt)}</small> : null}
                    {word.lastFeedback ? <p className="word-feedback">Seneste rettelse: {word.lastFeedback}</p> : null}
                    {word.example ? <p className="word-example" lang="fi">{word.example}</p> : null}
                  </li>
                ))}
                </ul> : <p className="empty-copy word-filter-empty">Ingen ord matcher det filter eller den søgning.</p>}
              </>
            ) : <p className="empty-copy">Ord og fremskridt vises her efter din første gemte øvesamtale.</p>}
          </details>

          <div className="archive-grid">
            <section className="archive-card" aria-labelledby="history-title">
              <span className="card-kicker">DIN HISTORIK</span>
              <h3 id="history-title">Seneste samtaler</h3>
              <p className="archive-help">Varighed og pris er estimater i USD. GPT-Live-tale beregnes fra sessionstid; baggrundskald måles fra den nye registrering og frem.</p>
              {historyError ? <p className="empty-copy">{historyError}</p> : history.length ? (
                <div className="archive-list">
                  {history.map((session) => (
                    <details className="archive-item" key={session.id}>
                      <summary><span><strong>{formatDate(session.startedAt)}</strong><small>{session.kind === "a1_test" ? `A1-taletest${session.a1Assessment ? ` · ${session.a1Assessment.outcome === "passed" ? "bestået" : session.a1Assessment.outcome === "incomplete" ? "ikke vurderbar" : "øv videre"}` : ""}` : "Samtale"} · {formatDuration(session.durationSeconds)} · ca. {formatUsd(session.estimatedApiCostUsd)} · {session.status === "completed" ? "Gemt" : "Delvist gemt"}{session.closeReason ? ` · ${closeReasonLabel(session.closeReason, session.closeConfirmed)}` : ""}</small></span><span className="archive-arrow" aria-hidden="true">⌄</span></summary>
                      <p>{session.summary ?? "Ingen opsummering endnu. Du kan stadig læse samtalen herunder."}</p>
                      {session.recap ? <div className="recap-details">
                        {session.recap.progress.length > 0 && <p><strong>Det lykkedes:</strong> {session.recap.progress.join(" · ")}</p>}
                        {session.recap.needsWork.length > 0 && <p><strong>Øv videre:</strong> {session.recap.needsWork.join(" · ")}</p>}
                        {session.recap.nextStep && <p><strong>Næste skridt:</strong> {session.recap.nextStep}</p>}
                      </div> : null}
                      <div className="archive-transcript">
                        {session.transcript.map((line, index) => <div className="archive-line" key={`${session.id}-${index}`}><strong>{line.speaker === "dig" ? "Dig" : "Tutor"}</strong><span>{line.text}</span></div>)}
                      </div>
                    </details>
                  ))}
                </div>
              ) : <p className="empty-copy">Dine gemte samtaler vises her, når du har afsluttet en øvetur.</p>}
            </section>

            <section className="archive-card" aria-labelledby="ideas-title">
              <span className="card-kicker">TIL SENERE</span>
              <h3 id="ideas-title">Idéer og rettelser</h3>
              <p className="archive-help">Du kan sige en idé eller rettelse til senere med dine egne ord. Tydeligt beskrevne ønsker og problemer med appen kan blive gemt automatisk.</p>
              {ideaMessage ? <p className="idea-message" role="status">{ideaMessage}</p> : null}
              {ideasError ? <p className="empty-copy">{ideasError}</p> : ideas.length ? (
                <ul className="idea-list">
                  {ideas.map((note) => (
                    <li className={note.status === "done" ? "idea-item done" : "idea-item"} key={note.id}>
                      <div className="idea-meta"><span>{note.kind === "correction" ? "Rettelse" : "Idé"}</span><time dateTime={note.createdAt}>{formatDate(note.createdAt)}</time></div>
                      <p>{note.content}</p>
                      <button type="button" onClick={() => { void toggleIdea(note); }}>{note.status === "done" ? "Genåbn" : "Markér som klaret"}</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="empty-copy">Ingen idéer gemt endnu. Du kan diktere den første under næste samtale.</p>}
            </section>
          </div>

          {transcript.length > 0 ? (
            <details className="transcript-wrap"><summary>Se transkript fra samtalen</summary><div className="transcript" aria-live="polite">{transcript.map((item, index) => <div className="bubble" key={`${item.speaker}-${item.startMs ?? index}-${index}`}><strong>{item.speaker}</strong>{item.text}</div>)}</div></details>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function apiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Kunne ikke gennemføre handlingen.";
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Kunne ikke gennemføre handlingen.";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("da-DK", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short" }).format(new Date(value));
}

function isWordDue(word: WordProgress): boolean {
  return !word.nextReviewAt || new Date(word.nextReviewAt).getTime() <= Date.now();
}

function wordStageLabel(word: WordProgress): string {
  const stage = practiceStage(word);
  if (stage === "introduced") return "Kun nævnt";
  if (stage === "once") return "Ét vurderet forsøg";
  if (stage === "secure") return "Sikker efter score";
  return "Øvet flere gange";
}

function safeLiveEvent(value: unknown): LiveEvent | null {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === "object" ? parsed as LiveEvent : null;
  } catch {
    return null;
  }
}

function appendTranscript(items: TranscriptLine[], item: TranscriptLine): TranscriptLine[] {
  const last = items.at(-1);
  const closeInTime = last?.endMs === undefined || item.startMs === undefined || item.startMs - last.endMs < 1600;
  if (last?.speaker === item.speaker && closeInTime) {
    return [
      ...items.slice(0, -1),
      { ...last, text: last.text + item.text, endMs: item.endMs ?? last.endMs },
    ];
  }
  return [...items, item];
}

async function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", onState);
      reject(new Error("WebRTC-forbindelsen brugte for lang tid."));
    }, 10_000);
    function onState() {
      if (peer.iceGatheringState !== "complete") return;
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onState);
      resolve();
    }
    peer.addEventListener("icegatheringstatechange", onState);
    onState();
  });
}
