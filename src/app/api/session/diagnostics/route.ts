import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { parseDiagnosticEvent } from "@/lib/session-diagnostics";
import { saveDiagnosticEvents } from "@/lib/session-diagnostics-server";
import { isDatabaseConfigured } from "@/db";

export async function POST(request: Request) {
  if (!(await getSessionFromRequest(request))) return NextResponse.json({ error: "Ikke logget ind." }, { status: 401 });
  if (!isDatabaseConfigured()) return NextResponse.json({ error: "Fejllog er ikke konfigureret." }, { status: 503 });
  const raw = await request.text();
  if (raw.length > 16_000) return NextResponse.json({ error: "For stor fejllog." }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Ugyldig fejllog." }, { status: 400 }); }
  if (!Array.isArray(body) || body.length < 1 || body.length > 20) {
    return NextResponse.json({ error: "Ugyldigt antal hændelser." }, { status: 400 });
  }
  const events = body.map(parseDiagnosticEvent);
  if (events.some((event) => !event)) return NextResponse.json({ error: "Ugyldig hændelse." }, { status: 400 });
  try {
    await saveDiagnosticEvents(events as NonNullable<(typeof events)[number]>[]);
    return NextResponse.json({ saved: events.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not save session diagnostics", error);
    return NextResponse.json({ error: "Kunne ikke gemme fejllog." }, { status: 500 });
  }
}
