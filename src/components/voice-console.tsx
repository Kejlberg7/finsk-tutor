"use client";

import { useRef, useState } from "react";

type Transcript = { speaker: "dig" | "tutor"; text: string };

export default function VoiceConsole() {
  const [status, setStatus] = useState("Klar til en samtale.");
  const [transcript, setTranscript] = useState<Transcript[]>([]);
  const [active, setActive] = useState(false);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function closeConnection() {
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    channelRef.current?.close();
    peerRef.current?.close();
    microphoneRef.current = null;
    channelRef.current = null;
    peerRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setActive(false);
  }

  async function start() {
    setStatus("Forbinder…");
    setTranscript([]);
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
        const event = JSON.parse(message.data) as { type?: string; delta?: string };
        if (event.type === "session.started") setStatus("Forbundet — tal bare.");
        if (event.type === "session.closed") {
          setStatus("Samtalen er afsluttet.");
          closeConnection();
        }
        if (event.type === "input_audio_transcription.delta" && event.delta) {
          setTranscript((current) => appendTranscript(current, "dig", event.delta!));
        }
        if (event.type === "output_audio_transcript.delta" && event.delta) {
          setTranscript((current) => appendTranscript(current, "tutor", event.delta!));
        }
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
      const result = await response.json() as { transport?: { sdp?: string } };
      if (!result.transport?.sdp) throw new Error("OpenAI returnerede ikke et SDP-svar.");
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      setActive(true);
    } catch (error) {
      closeConnection();
      setStatus(error instanceof Error ? error.message : "Kunne ikke starte samtalen.");
    }
  }

  function stop() {
    channelRef.current?.close();
    closeConnection();
    setStatus("Samtalen er stoppet.");
  }

  return (
    <main className="shell">
      <section className="card">
        <div className="eyebrow">Finsk Tutor · første prototype</div>
        <h1>Tal finsk i små bidder.</h1>
        <p className="intro">Forklaringerne er på engelsk. Tutorens finske sætninger er korte, tydelige og lavet til gentagelse.</p>
        <div className="controls">
          <button className="primary" type="button" onClick={start} disabled={active}>Start samtale</button>
          <button className="danger" type="button" onClick={stop} disabled={!active}>Stop</button>
        </div>
        <div className="status" role="status">{status}</div>
        <audio ref={audioRef} autoPlay controls />
        {transcript.length > 0 ? (
          <div className="transcript" aria-live="polite">
            {transcript.map((item, index) => (
              <div className="bubble" key={`${item.speaker}-${index}`}>
                <strong>{item.speaker}</strong>
                {item.text}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function apiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Kunne ikke starte samtalen.";
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Kunne ikke starte samtalen.";
}

function appendTranscript(items: Transcript[], speaker: Transcript["speaker"], text: string): Transcript[] {
  const last = items.at(-1);
  if (last?.speaker === speaker) return [...items.slice(0, -1), { ...last, text: last.text + text }];
  return [...items, { speaker, text }];
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
