const token = process.env.TUTOR_READ_API_TOKEN;
if (!token) {
  console.error("TUTOR_READ_API_TOKEN mangler i .env.local.");
  process.exit(1);
}

const requestedId = process.argv[2] ? Number(process.argv[2]) : null;
if (requestedId !== null && (!Number.isSafeInteger(requestedId) || requestedId < 1)) {
  console.error("Brug et positivt samtalenummer, fx npm run tutor:diagnostics -- 23.");
  process.exit(1);
}

const baseUrl = process.env.TUTOR_READ_API_BASE_URL || "https://finsk-tutor.vercel.app";
const response = await fetch(`${baseUrl}/api/assistant/context?sessions=20&notes=1&diagnostics=500`, {
  headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
});
if (!response.ok) {
  const body = await response.json().catch(() => null);
  console.error(body?.error || `Tutor-API svarede med HTTP ${response.status}.`);
  process.exit(1);
}

const data = await response.json();
const sessions = requestedId ? data.sessions.filter((item) => item.id === requestedId) : data.sessions.slice(0, 10);
console.log("Seneste samtaledele:");
for (const session of sessions) {
  console.log(`#${session.id} ${session.startedAt} · ${Math.round(session.durationSeconds / 60)} min · afslutning: ${session.closeReason || "ukendt"}${session.closeConfirmed ? " (bekræftet af OpenAI)" : " (ikke bekræftet)"}`);
}
const events = (requestedId
  ? data.diagnostics.filter((event) => event.sessionId === requestedId)
  : data.diagnostics.slice(0, 120)).reverse();
console.log(`\nDiagnostiske hændelser (${events.length}, ældste først):`);
for (const event of events) {
  const details = event.details && Object.keys(event.details).length ? ` ${JSON.stringify(event.details)}` : "";
  console.log(`${event.occurredAt} #${event.sessionId ?? "opstart"} ${event.eventType}${event.code ? ` [${event.code}]` : ""}${event.message ? ` ${event.message}` : ""}${details}`);
}
