import assert from "node:assert/strict";
import test from "node:test";
import { flushSessionDiagnostics, reportSessionDiagnostic } from "../src/lib/session-diagnostics-client";

test("failed telemetry stays queued and is retried without duplicate delivery", async () => {
  const values = new Map<string, string>();
  const descriptors = new Map(["window", "navigator", "localStorage", "fetch"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  const setGlobal = (key: string, value: unknown) => Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value,
  });
  try {
    setGlobal("window", {});
    setGlobal("navigator", { onLine: true });
    setGlobal("localStorage", {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
    });
    let attempts = 0;
    let sent: unknown = null;
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      attempts++;
      sent = JSON.parse(String(options?.body));
      return { ok: attempts > 1 } as Response;
    }) as typeof fetch;

    reportSessionDiagnostic({ attemptId: "22222222-2222-4222-8222-222222222222", eventType: "live.error", code: "test" });
    await flushSessionDiagnostics();
    assert.equal(JSON.parse([...values.values()][0]).length, 1);
    await flushSessionDiagnostics();
    assert.equal(JSON.parse([...values.values()][0]).length, 0);
    assert.equal(attempts, 2);
    assert.equal((sent as Array<{ eventType: string }>)[0].eventType, "live.error");
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
