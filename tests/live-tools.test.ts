import assert from "node:assert/strict";
import test from "node:test";
import { LiveToolRunner } from "../src/lib/live-tool-runner";

const envelope = (type: string, extra = {}, delegation = "d1") => ({ type: "response.event", delegation_id: delegation, event: { type, ...extra } });
const call = (id: string) => ({ item: { type: "function_call", call_id: id, name: "get_practice_history", arguments: '{"scope":"strong"}' } });

test("Live tools use item events even when the completed response output is empty; duplicates execute once", async () => {
  const sent: Record<string, unknown>[] = [];
  const executed: string[] = [];
  const runner = new LiveToolRunner(async (c) => { executed.push(c.callId); return { total: 12 }; }, (e) => sent.push(e));
  await runner.handle(envelope("response.created", { response: { id: "r1" } }));
  await runner.handle(envelope("response.output_item.done", call("c1")));
  await runner.handle(envelope("response.output_item.done", call("c1")));
  assert.equal(executed.length, 0);
  const done = envelope("response.completed", { response: { id: "r1", output: [] } });
  await Promise.all([runner.handle(done), runner.handle(done)]);
  assert.deepEqual(executed, ["c1"]);
  assert.deepEqual(sent.map((e) => e.type), ["response.item.create", "response.create"]);
  assert.equal((sent[0].item as { call_id: string }).call_id, "c1");
});

test("all tool outputs precede continuation and a failed call is explicitly reported", async () => {
  const sent: Record<string, unknown>[] = [];
  const runner = new LiveToolRunner(async (c) => { if (c.callId === "bad") throw new Error("offline"); return { saved: true }; }, (e) => sent.push(e));
  await runner.handle(envelope("response.created", { response: { id: "r2" } }));
  await runner.handle(envelope("response.output_item.done", call("good")));
  await runner.handle(envelope("response.output_item.done", call("bad")));
  await runner.handle(envelope("response.completed", { response: { id: "r2" } }));
  assert.deepEqual(sent.map((e) => e.type), ["response.item.create", "response.item.create", "response.create"]);
  assert.match((sent[1].item as { output: string }).output, /tool failed/);
});
