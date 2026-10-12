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

/** One model request (timed 10 ms, first token after 4 ms) and one tool call of `toolMs`. */
function work(m: MetricsCollector, clock: { t: number }, toolMs: number, id: string) {
  const emit = (r: object) => m.onRecord(r as StreamRecord, clock.t);
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: { role: "assistant" } });
  clock.t += 4;
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta" } });
  clock.t += 6;
  emit({ type: "message_end", message: { role: "assistant", usage: usage(10, 0.1) } });
  emit({ type: "tool_execution_start", toolCallId: id, toolName: "read" });
  clock.t += toolMs;
  emit({ type: "tool_execution_end", toolCallId: id, toolName: "read", isError: false });
}

test("entry: cumulative metrics, only new samples, nothing when unchanged", () => {
  const clock = { t: 0 };
  const m = new MetricsCollector(() => clock.t);
  work(m, clock, 7, "a");
  m.sampleContext(12.6);

  const first = m.entry()!;
  assert.equal(first.version, 1);
  assert.equal("wallMs" in first || "phases" in first || "retries" in first, false);
  assert.equal(first.turns, 1);
  assert.equal(first.contextPeakPercent, 13);
  assert.deepEqual(first.samples, { ttftMs: [4], latencyMs: [10], toolMs: { read: [7] } });
  assert.equal(m.entry(), undefined);

  work(m, clock, 3, "b");
  m.compaction(usage(1, 0.5));
  const second = m.entry()!;
  assert.equal(second.turns, 2);
  assert.equal(second.compactions, 1);
  assert.equal(second.costUsd, 0.7);
  assert.deepEqual(second.tools, { read: { calls: 2, errors: 0, msP50: 3, msMax: 7 } });
  assert.deepEqual(second.samples, { ttftMs: [4], latencyMs: [10], toolMs: { read: [3] } });
});

test("restore continues from earlier entries: totals and percentiles as if never stopped", () => {
  const clock = { t: 0 };
  const whole = new MetricsCollector(() => clock.t);
  const first = new MetricsCollector(() => clock.t);
  for (const [i, ms] of [5, 9, 1].entries()) {
    work(whole, clock, ms, `w${i}`);
    work(first, clock, ms, `f${i}`);
  }
  const entries: unknown[] = [{ contextPeakPercent: 3 }, first.entry()]; // old-format entry: ignored

  const resumed = new MetricsCollector(() => clock.t);
  resumed.restore(entries);
  assert.equal(resumed.entry(), undefined); // nothing new yet
  work(whole, clock, 20, "w3");
  work(resumed, clock, 20, "r3");

  const a = whole.entry()!;
  const b = resumed.entry()!;
  // Same, except that the cache check starts over: the first request after a resume is not checked.
  assert.deepEqual({ ...b, samples: undefined, cacheMisses: [] }, { ...a, samples: undefined, cacheMisses: [] });
  assert.deepEqual(b.cacheMisses, a.cacheMisses.filter((miss) => miss.turn !== 4));
  assert.deepEqual(b.samples, { ttftMs: [4], latencyMs: [10], toolMs: { read: [20] } });
  assert.deepEqual(b.tools, { read: { calls: 4, errors: 0, msP50: 5, msMax: 20 } });
});
