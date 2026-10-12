import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY } from "../shared/protocol.ts";
import type { StreamRecord } from "./stream.ts";
import { MetricsCollector, percentile } from "./metrics.ts";

const usage = (n: number, cost: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n, cost: { total: cost } });

test("percentile uses nearest rank", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([3, 1, 2], 50), 2);
});

test("collects phases, model latency, parallel tools, usage and the context peak", () => {
  let t = 0;
  const m = new MetricsCollector(() => t);
  const emit = (r: object) => m.onRecord(r as StreamRecord, t);

  m.phase("setup");
  t = 10;
  m.phase("run");

  t = 15;
  emit({ type: "turn_start" }); // request sent
  emit({ type: "message_start", message: { role: "user" } });
  t = 25;
  emit({ type: "message_start", message: { role: "assistant" } }); // response started
  t = 30;
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
  t = 50;
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta" } });
  t = 70;
  emit({ type: "message_end", message: { role: "assistant", usage: usage(40, 0.2) } });
  emit({ type: "message_end", message: { role: "user", usage: usage(1000, 9) } }); // ignored

  // Two parallel bash calls, ending in reverse order.
  emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" });
  t = 75;
  emit({ type: "tool_execution_start", toolCallId: "b", toolName: "bash" });
  t = 80;
  emit({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", isError: true });
  t = 170;
  emit({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: false });

  emit({ type: "auto_retry_start" });
  emit({ type: "compaction_end", aborted: false, result: { usage: usage(10, 0.05) } });
  emit({ type: "compaction_end", aborted: true, result: undefined });
  emit({ type: "entry_appended", entry: { type: "custom", customType: ENTRY.metrics, data: { contextPeakPercent: 61 } } });
  emit({ type: "entry_appended", entry: { type: "custom", customType: "other", data: { contextPeakPercent: 99 } } });

  t = 200;
  m.phase("validate");
  t = 205;
  m.endPhase();

  const s = m.snapshot();
  assert.deepEqual(s.phases, { setupMs: 10, runMs: 190, validateMs: 5 });
  assert.equal(s.wallMs, 205);
  assert.deepEqual(s.tokens, { input: 50, output: 50, cacheRead: 50, cacheWrite: 50 });
  assert.equal(s.costUsd, 0.25);
  assert.equal(s.turns, 1);
  assert.deepEqual(s.model, { calls: 1, ttftMsP50: 15, latencyMsP50: 55, latencyMsMax: 55 });
  assert.deepEqual(s.tools, { bash: { calls: 2, errors: 1, msP50: 5, msMax: 100 } });
  assert.equal(s.retries, 1);
  assert.equal(s.compactions, 1);
  assert.equal(s.contextPeakPercent, 61);
});

test("reports requests that read less than the previous request cached", () => {
  const m = new MetricsCollector(() => 0);
  const request = (input: number, cacheRead: number, cacheWrite: number) => {
    m.onRecord({ type: "turn_start" } as StreamRecord);
    m.onRecord({ type: "message_end", message: { role: "assistant", usage: { input, output: 1, cacheRead, cacheWrite } } } as StreamRecord);
  };

  request(2, 0, 1000); // turn 1: first request, nothing expected
  request(2, 1000, 500); // turn 2: full hit
  request(2, 1450, 100); // turn 3: 1450 >= 95% of 1500, still a hit
  request(0, 0, 0); // turn 4: failed request without usage, skipped
  request(2, 0, 1700); // turn 5: miss, expected 1550 (turn 3)
  request(2, 1700, 50); // turn 6: hit against turn 5
  m.onRecord({ type: "compaction_end", aborted: false, result: {} } as StreamRecord);
  request(2, 0, 400); // turn 7: new prefix after compaction, not a miss
  request(2, 100, 400); // turn 8: miss, expected 400

  assert.deepEqual(m.snapshot().cacheMisses, [
    { turn: 5, expected: 1550, cacheRead: 0 },
    { turn: 8, expected: 400, cacheRead: 100 },
  ]);
});
