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
