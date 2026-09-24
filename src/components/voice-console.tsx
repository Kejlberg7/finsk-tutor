"use client";

import { useEffect, useRef, useState } from "react";
import type { LearningSnapshot, TranscriptLine } from "@/lib/learning-types";

const EMPTY_LEARNING: LearningSnapshot = {
  memoryReady: false,
  level: "Ny begynder",
  currentFocus: "Korte hverdagssætninger og tydelig udtale",
  nextLesson: "Hilsner og at præsentere sig selv",
  upcomingLessons: ["Hilsner og at præsentere sig selv"],
  dueWords: [],
  wordProgress: [],
  knownWordCount: 0,
  masteredWordCount: 0,
  dueWordCount: 0,
  completedSessionCount: 0,
  lastSummary: null,
};

type LiveEvent = {
  type?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  error?: { message?: string };
  event?: { type?: string };
};

export default function VoiceConsole() {
  const [status, setStatus] = useState("Klar til en samtale.");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [learning, setLearning] = useState<LearningSnapshot>(EMPTY_LEARNING);
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const appSessionIdRef = useRef<number | null>(null);
  const finalisingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const nextGoal = [5, 20, 50, 100, 200].find((goal) => learning.masteredWordCount < goal)
    ?? Math.ceil((learning.masteredWordCount + 1) / 100) * 100;
  const milestonePercent = Math.min(100, Math.round((learning.masteredWordCount / nextGoal) * 100));

  useEffect(() => {
    void fetch("/api/learning", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Kunne ikke hente læringsplanen.");
        return response.json() as Promise<LearningSnapshot>;
      })
      .then(setLearning)
      .catch(() => undefined);
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
      peerRef.current?.close();
    };
  }, []);

  function updateTranscript(speaker: TranscriptLine["speaker"], event: LiveEvent) {
    if (!event.delta) return;
    const next = appendTranscript(transcriptRef.current, {
      speaker,
      text: event.delta,
      startMs: event.start_ms,
      endMs: event.end_ms,
    });
    transcriptRef.current = next;
    setTranscript(next);
  }

  function closeConnection() {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    channelRef.current?.close();
    peerRef.current?.close();
    microphoneRef.current = null;
    channelRef.current = null;
    peerRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setActive(false);
    setConnecting(false);
  }

  async function start() {
    setStatus("Forbinder…");
    setConnecting(true);
    setTranscript([]);
    transcriptRef.current = [];
    appSessionIdRef.current = null;
    finalisingRef.current = false;

    try {
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      peer.ontrack = (event) => {
        if (!audioRef.current) return;
        audioRef.current.srcObject = new MediaStream([event.track]);
        void audioRef.current.play().catch(() => setStatus("Tryk på afspilningsknappen for at høre tutorens stemme."));
      };

      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneRef.current = microphone;
      microphone.getAudioTracks().forEach((track) => peer.addTrack(track, microphone));

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onmessage = (message) => {
        const event = safeLiveEvent(message.data);
        if (!event) return;
        if (event.type === "session.started") {
          setStatus("Forbundet — tal bare.");
          sendEvent({
            type: "session.instructions.append",
            event_id: "start_lesson",
            delegation_id: null,
            content: "Open the lesson now with a very brief English greeting and today's focus, then give the first short Finnish phrase.",
          });
        }
        if (event.type === "session.delegation.created") {
          setStatus("Planlægger næste øvelse — du kan stadig tale.");
        }
        if (event.type === "response.event" && ["response.completed", "response.failed", "response.incomplete"].includes(event.event?.type ?? "")) {
          setStatus("Forbundet — tal bare.");
        }
        if (event.type === "session.closed") {
          closeConnection();
          void saveSession();
        }
        if (event.type === "session.input_transcript.delta") updateTranscript("dig", event);
        if (event.type === "session.output_transcript.delta") updateTranscript("tutor", event);
        if (event.type === "error" && event.error?.message) setStatus(event.error.message);
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer);
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Mangler lokal WebRTC-beskrivelse.");

      const response = await fetch("/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(apiErrorMessage(payload));
      }
      const result = await response.json() as {
        transport?: { sdp?: string };
        app_session_id?: number | null;
        learning?: LearningSnapshot;
      };
      if (!result.transport?.sdp) throw new Error("OpenAI returnerede ikke et SDP-svar.");
      appSessionIdRef.current = result.app_session_id ?? null;
      if (result.learning) setLearning(result.learning);
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      setActive(true);
      setConnecting(false);
    } catch (error) {
      closeConnection();
      setStatus(error instanceof Error ? error.message : "Kunne ikke starte samtalen.");
    }
  }

  function stop() {
    setStatus("Afslutter og gemmer samtalen…");
    if (channelRef.current?.readyState === "open") {
      sendEvent({ type: "session.close" });
      closeTimerRef.current = window.setTimeout(() => {
        closeConnection();
        void saveSession();
      }, 2500);
      return;
    }
    closeConnection();
    void saveSession();
  }

  function sendEvent(event: Record<string, unknown>) {
    if (channelRef.current?.readyState === "open") channelRef.current.send(JSON.stringify(event));
  }

  async function saveSession() {
    if (finalisingRef.current) return;
    finalisingRef.current = true;
    const sessionId = appSessionIdRef.current;
    const finalTranscript = transcriptRef.current;

    if (!sessionId) {
      setStatus("Samtalen er afsluttet. Hukommelsen er ikke sat op endnu.");
      return;
    }
    if (!finalTranscript.some((line) => line.text.trim())) {
      setStatus("Samtalen er afsluttet, men der var intet transkript at gemme.");
      return;
    }

    setStatus("Samtalen analyseres og føjes til din læringsplan…");
    try {
      const response = await fetch("/api/session/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, transcript: finalTranscript }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(payload));
      const nextLearning = (payload as { learning?: LearningSnapshot } | null)?.learning;
      if (nextLearning) setLearning(nextLearning);
      setStatus("Gemt — næste samtale fortsætter ud fra det, du øvede.");
    } catch (error) {
      setStatus(error instanceof Error ? `Samtalen sluttede, men blev ikke gemt: ${error.message}` : "Samtalen sluttede, men blev ikke gemt.");
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
              <button className="primary" type="button" onClick={start} disabled={active || connecting}>
                <span className="play-symbol" aria-hidden="true">▶</span>{connecting ? "Forbinder…" : "Start samtale"}
              </button>
              <button className="danger" type="button" onClick={stop} disabled={!active}>Stop og gem</button>
            </div>
            <div className="session-status" role="status"><span className={active ? "status-light active" : "status-light"} aria-hidden="true" />{status}</div>
          </div>
        </section>

        <div className="audio-row"><span>Lyd fra tutoren</span><audio ref={audioRef} autoPlay controls /></div>

        <section className="dashboard" aria-labelledby="dashboard-title">
          <div className="section-heading"><div><span className="section-kicker">DIT OVERBLIK</span><h2 id="dashboard-title">Sådan går det med din finsk</h2></div><span className="level-chip">{learning.level}</span></div>

          <div className="dashboard-main">
            <section className="milestone-card" aria-label="Din næste milepæl">
              <div className="milestone-copy">
                <span className="card-kicker">NÆSTE MILEPÆL</span>
                <h3>{nextGoal} sikre ord</h3>
                <p>Ord bliver “sikre”, når de har klaret flere øvesamtaler. De dukker stadig op til repetition, bare sjældnere.</p>
                <div className="milestone-count"><strong>{learning.masteredWordCount}</strong><span>af {nextGoal} ord</span></div>
              </div>
              <div className="milestone-ring" role="progressbar" aria-label="Fremskridt mod næste ordmilepæl" aria-valuenow={learning.masteredWordCount} aria-valuemin={0} aria-valuemax={nextGoal} style={{ background: `conic-gradient(var(--lime) ${milestonePercent}%, #335e50 ${milestonePercent}% 100%)` }}>
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
              <p className="lesson-note">Planen bygger på din seneste gemte samtale og dine øveord. Den opdateres, når du stopper og gemmer. Tutoren kan tilpasse rækkefølgen undervejs.{learning.upcomingLessons.length < 3 ? " Flere blokke vises efter din næste gemte samtale." : ""}</p>
            </section>
          </div>

          <div className="stat-grid" aria-label="Dine øvestatistikker">
            <div className="stat-card"><span className="stat-icon green" aria-hidden="true">✧</span><strong>{learning.knownWordCount}</strong><span>Ord mødt</span></div>
            <div className="stat-card"><span className="stat-icon lime" aria-hidden="true">✓</span><strong>{learning.masteredWordCount}</strong><span>Sikre ord</span></div>
            <div className="stat-card"><span className="stat-icon peach" aria-hidden="true">↺</span><strong>{learning.dueWordCount}</strong><span>Klar til repetition</span></div>
            <div className="stat-card"><span className="stat-icon blue" aria-hidden="true">◉</span><strong>{learning.completedSessionCount}</strong><span>Gemte samtaler</span></div>
          </div>

          <div className="detail-grid">
            <section className="review-card">
              <div className="detail-heading"><div><span className="card-kicker">KOMMER IGEN</span><h3>Ord til repetition</h3></div><span className="detail-count">{learning.dueWordCount}</span></div>
              {learning.dueWords.length ? (
                <div className="review-words" aria-label="Ord til repetition">
                  {learning.dueWords.map((word) => <span key={word.finnish} lang="fi">{word.finnish}</span>)}
                </div>
              ) : <p className="empty-copy">Ingen ord er klar til repetition lige nu. Godt arbejde!</p>}
            </section>
            <section className="recent-card">
              <span className="card-kicker">SIDSTE SAMTALE</span>
              <h3>Det tog du med dig</h3>
              <p>{learning.lastSummary ?? "Efter din første gemte samtale får du en kort opsummering her."}</p>
            </section>
          </div>

          <details className="word-progress">
            <summary><span><span className="card-kicker">ORD FOR ORD</span><strong>Se dine fremskridt</strong><small>Øveniveau, forsøg og rettelser</small></span><span className="details-arrow" aria-hidden="true">↗</span></summary>
            <p className="word-progress-note">Procenterne bygger på øvede ord og tydelige rettelser. De er ikke en måling af din accent eller et officielt sprogniveau.</p>
            {learning.wordProgress?.length ? (
              <ul>
                {learning.wordProgress.map((word) => (
                  <li key={word.finnish}>
                    <div className="word-progress-heading"><div><strong lang="fi">{word.finnish}</strong><span>{word.english}</span></div><strong>{word.mastery * 20}%</strong></div>
                    <div className="progress-track" role="progressbar" aria-label={`Øveniveau for ${word.finnish}`} aria-valuenow={word.mastery * 20} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${word.mastery * 20}%` }} /></div>
                    <small>{word.correctCount} tydeligt rigtige · {word.incorrectCount} rettet</small>
                    {word.lastFeedback ? <p className="word-feedback">Seneste rettelse: {word.lastFeedback}</p> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="empty-copy">Ord og fremskridt vises her efter din første gemte øvesamtale.</p>}
          </details>

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
