type FunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string };
type Envelope = { type?: string; delegation_id?: string; event?: {
  type?: string; response?: { id?: string }; item?: FunctionCall;
} };
type Group = { calls: Map<string, FunctionCall>; finished: boolean };

/** Live completion snapshots omit output items. Collect calls from individual item events. */
export class LiveToolRunner {
  private groups = new Map<string, Group>();
  private current = new Map<string, string>();
  private completed = new Set<string>();
  constructor(
    private execute: (call: { callId: string; name: string; arguments: unknown }) => Promise<unknown>,
    private send: (event: Record<string, unknown>) => void,
  ) {}

  async handle(value: unknown) {
    if (!value || typeof value !== "object") return;
    const envelope = value as Envelope;
    if (envelope.type !== "response.event" || !envelope.event) return;
    const event = envelope.event;
    const delegation = envelope.delegation_id ?? "default";
    if (event.type === "response.created" && event.response?.id) this.current.set(delegation, event.response.id);
    const id = event.response?.id ?? this.current.get(delegation);
    if (!id || this.completed.has(id)) return;
    const group = this.groups.get(id) ?? { calls: new Map<string, FunctionCall>(), finished: false };
    this.groups.set(id, group);
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const call = event.item;
      if (typeof call.call_id === "string" && typeof call.name === "string" && typeof call.arguments === "string") group.calls.set(call.call_id, call);
    }
    if (event.type !== "response.completed" || group.finished) return;
    group.finished = true;
    if (!group.calls.size) { this.completed.add(id); this.groups.delete(id); return; }
    const outputs = await Promise.all([...group.calls.values()].map(async (call) => {
      let output: unknown;
      try {
        output = await this.execute({ callId: call.call_id, name: call.name, arguments: JSON.parse(call.arguments) });
      } catch {
        output = { error: "The tool failed. Do not claim a lookup or save succeeded. Continue using only verified information." };
      }
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) };
    }));
    // All outputs must precede the single continuation, even if calls resolve out of order.
    for (const item of outputs) this.send({ type: "response.item.create", event_id: crypto.randomUUID(), item });
    this.send({ type: "response.create", event_id: crypto.randomUUID() });
    this.completed.add(id);
    this.groups.delete(id);
  }
}
