import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionMetrics from "./index.ts";
import { ENTRY, METRICS_FLUSH_CHANNEL, type SessionMetricsEntry } from "../shared/protocol.ts";

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
function fakePi(branch: object[] = []) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const channels = new Map<string, Set<(data: unknown) => void>>();
  const entries: Array<{ customType: string; data: SessionMetricsEntry }> = [];
  let percent: number | null = null;
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.set(event, handler),
    appendEntry: (customType: string, data: SessionMetricsEntry) => void entries.push({ customType, data }),
    events: {
      emit: (channel: string, data: unknown) => channels.get(channel)?.forEach((h) => h(data)),
      on: (channel: string, h: (data: unknown) => void) => {
        if (!channels.has(channel)) channels.set(channel, new Set());
        channels.get(channel)!.add(h);
        return () => channels.get(channel)!.delete(h);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }),
    sessionManager: { getBranch: () => branch },
  };
  sessionMetrics(pi);
  return {
    entries,
    setPercent: (p: number | null) => (percent = p),
    emit: (name: string, event: object = {}) => handlers.get(name)?.({ type: name, ...event }, ctx),
    flush: () => pi.events.emit(METRICS_FLUSH_CHANNEL, undefined),
    listeners: () => channels.get(METRICS_FLUSH_CHANNEL)?.size ?? 0,
  };
}

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };

function oneTurn(pi: ReturnType<typeof fakePi>) {
  pi.emit("turn_start");
  pi.emit("message_start", { message: { role: "assistant" } });
  pi.emit("message_end", { message: { role: "assistant", usage } });
  pi.emit("tool_execution_start", { toolCallId: "1", toolName: "bash" });
  pi.emit("tool_execution_end", { toolCallId: "1", toolName: "bash", isError: true });
}

test("adds a metrics entry at settle, keeping entries other handlers proposed", () => {
  const pi = fakePi();
  pi.emit("session_start");
  pi.setPercent(42.4);
  oneTurn(pi);
  pi.setPercent(90); // user messages are not sampled
  pi.emit("message_end", { message: { role: "user" } });

  const other = { type: "custom_message", customType: "x", content: "c", display: true };
  const result = pi.emit("agent_before_settle", { outcome: "completed", entries: [other] });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], other);
  const { customType, data } = result.entries[1];
  assert.equal(customType, ENTRY.metrics);
  assert.equal(data.turns, 1);
  assert.equal(data.contextPeakPercent, 42);
  assert.deepEqual(data.tokens, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(data.tools.bash, { calls: 1, errors: 1, msP50: data.tools.bash.msP50, msMax: data.tools.bash.msMax });

  // Unchanged: nothing more at the next settle or on shutdown.
  assert.equal(pi.emit("agent_before_settle", { outcome: "completed", entries: [] }), undefined);
  pi.emit("session_shutdown", { reason: "quit" });
  assert.equal(pi.entries.length, 0);
});

test("counts compactions and appends on flush requests and on shutdown", () => {
  const pi = fakePi();
  pi.emit("session_start");
  pi.setPercent(70);
  pi.emit("session_compact", { compactionEntry: { usage } });
  pi.flush();
  assert.equal(pi.entries.length, 1);
  assert.equal(pi.entries[0].data.compactions, 1);
  assert.equal(pi.entries[0].data.contextPeakPercent, 70);
  pi.flush(); // unchanged
  assert.equal(pi.entries.length, 1);

  oneTurn(pi);
  pi.emit("session_shutdown", { reason: "new" });
  assert.equal(pi.entries.length, 2);
  assert.equal(pi.entries[1].data.turns, 1);
  assert.equal(pi.listeners(), 0); // unsubscribed
  pi.flush();
  assert.equal(pi.entries.length, 2);
});

test("continues from the branch's earlier metrics entries", () => {
  const first = fakePi();
  first.emit("session_start");
  oneTurn(first);
  first.flush();
  const branch = [
    { type: "message", message: { role: "user" } },
    { type: "custom", customType: ENTRY.metrics, data: first.entries[0].data },
    { type: "custom", customType: "other", data: { version: 1, turns: 99 } },
  ];

  const resumed = fakePi(branch);
  resumed.emit("session_start");
  oneTurn(resumed);
  resumed.flush();
  const total = resumed.entries[0].data;
  assert.equal(total.turns, 2);
  assert.equal(total.tools.bash.calls, 2);
  assert.equal(total.costUsd, 0.02);
  assert.equal(total.samples.toolMs.bash.length, 1); // only the new sample
});
