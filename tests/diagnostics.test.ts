import assert from "node:assert/strict";
import test from "node:test";
import { closeReasonLabel, parseDiagnosticEvent, redactDiagnosticMessage } from "../src/lib/session-diagnostics";

const valid = {
  id: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  sessionId: 23,
  eventType: "live.session_closed",
  code: "content",
  message: null,
  details: { reason: "content", voiceSeconds: 742, sdp: "private SDP", online: true },
  occurredAt: new Date().toISOString(),
};

test("diagnostics retain close reason and drop unapproved payload fields", () => {
  const result = parseDiagnosticEvent(valid);
  assert.equal(result?.code, "content");
  assert.deepEqual(result?.details, { reason: "content", voiceSeconds: 742, online: true });
  assert.equal(closeReasonLabel("content", true), "Stoppet af sikkerhedsfilter");
  assert.match(closeReasonLabel("connection_lost", false), /ikke bekræftet/);
});

test("diagnostics reject malformed or oversized events", () => {
  assert.equal(parseDiagnosticEvent({ ...valid, sessionId: -1 }), null);
  assert.equal(parseDiagnosticEvent({ ...valid, eventType: "bad event" }), null);
  assert.equal(parseDiagnosticEvent({ ...valid, message: "x".repeat(601) }), null);
  assert.equal(parseDiagnosticEvent({ ...valid, occurredAt: "2020-01-01" }), null);
});

test("diagnostic messages redact credential-shaped data", () => {
  const result = redactDiagnosticMessage("Bearer sk-example-secret-value-123456?token=private&key=also-private");
  assert.doesNotMatch(result, /example-secret|private|also-private/);
});
