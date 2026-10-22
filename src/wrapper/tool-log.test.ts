import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamRecord } from "./events.ts";
import { ToolLog } from "./tool-log.ts";

const text = (s: string) => ({ content: [{ type: "text", text: s }] });

test("logs calls in start order with turn, duration, error flag and output", () => {
  let t = Date.UTC(2026, 9, 5);
  const log = new ToolLog({ now: () => t });
  const emit = (e: object) => log.onRecord(e as StreamRecord);

  emit({ type: "turn_start" });
  emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.txt" } });
  t += 5;
  emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "false" } });
  t += 10;
  // b ends first (parallel)
  emit({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", isError: true, result: text("exit 1") });
  t += 20;
  emit({
    type: "tool_execution_end",
    toolCallId: "a",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "hello" }, { type: "image", data: "…" }] },
  });
  emit({ type: "turn_start" });
  emit({ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: { path: "c" } });

  assert.deepEqual(log.entries(), [
    {
      id: "a",
      tool: "read",
      turn: 1,
      startedAt: "2026-10-05T00:00:00.000Z",
      durationMs: 35,
      isError: false,
      args: { path: "a.txt" },
      output: "hello\n[image]",
      truncated: false,
      ref: null,
    },
    {
      id: "b",
      tool: "bash",
      turn: 1,
      startedAt: "2026-10-05T00:00:00.005Z",
      durationMs: 10,
      isError: true,
      args: { command: "false" },
      output: "exit 1",
      truncated: false,
      ref: null,
    },
    // never finished
    {
      id: "c",
      tool: "read",
      turn: 2,
      startedAt: "2026-10-05T00:00:00.035Z",
      durationMs: null,
      isError: null,
      args: { path: "c" },
      output: null,
      truncated: false,
      ref: null,
    },
  ]);
});

test("truncates long arg strings and output", () => {
  const log = new ToolLog({ maxArgChars: 4, maxOutputChars: 3 });
  const emit = (e: object) => log.onRecord(e as StreamRecord);
  emit({ type: "tool_execution_start", toolCallId: "w", toolName: "write", args: { path: "ab", content: "123456" } });
  emit({ type: "tool_execution_end", toolCallId: "w", toolName: "write", isError: false, result: text("okokok") });
  const [entry] = log.entries();
  assert.deepEqual(entry.args, { path: "ab", content: "1234… [2 more chars]" });
  assert.equal(entry.output, "oko… [3 more chars]");
  assert.equal(entry.truncated, true);
});

test("ref comes from the toolResult message_end, matched by toolCallId; output has no trailer", () => {
  const log = new ToolLog();
  const emit = (e: object) => log.onRecord(e as StreamRecord);
  const trailer = { type: "text", text: "[tool-ref #7]" };
  emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} });
  emit({ type: "tool_execution_start", toolCallId: "blocked", toolName: "bash", args: {} });
  emit({ type: "tool_execution_start", toolCallId: "plain", toolName: "bash", args: {} });
  emit({ type: "tool_execution_start", toolCallId: "open", toolName: "bash", args: {} });
  // Blocked: pi ends it without running it; the trailer only arrives with message_end.
  emit({ type: "tool_execution_end", toolCallId: "blocked", toolName: "bash", isError: true, result: text("blocked") });
  emit({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: false, result: text("hi") });
  emit({ type: "tool_execution_end", toolCallId: "plain", toolName: "bash", isError: false, result: text("x") });
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "blocked", content: [{ type: "text", text: "blocked" }, { ...trailer, text: "[tool-ref #8]" }] } });
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "hi" }, trailer] } });
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "plain", content: [{ type: "text", text: "x" }] } });
  emit({ type: "message_end", message: { role: "assistant", content: [trailer] } });
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "unknown", content: [trailer] } });
  const byId = Object.fromEntries(log.entries().map((e) => [e.id, e]));
  assert.equal(byId.a.ref, 7);
  assert.equal(byId.a.output, "hi");
  assert.equal(byId.blocked.ref, 8);
  assert.equal(byId.plain.ref, null);
  assert.equal(byId.open.ref, null);
});
