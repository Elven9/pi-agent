import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import type { ToolRef } from "./resolver.ts";
import { clearSummaries, SUMMARY_MAX_CHARS, summaryContext, Summarizer, type SummaryStream } from "./summary.ts";

function ref(id: string, output = "hi"): ToolRef & { handle: number } {
  return {
    handle: 1,
    ambiguous: false,
    toolCallId: id,
    toolName: "bash",
    isError: false,
    excluded: false,
    input: { command: "echo hi" },
    content: [{ type: "text", text: output }],
    output,
    startedAt: undefined,
    endedAt: undefined,
    durationMs: undefined,
    entryId: `e-${id}`,
    lookups: [],
    nestedTools: [],
    lookupOnly: false,
  };
}

const delta = (d: string) => ({ type: "text_delta", contentIndex: 0, delta: d }) as unknown as AssistantMessageEvent;
const done = { type: "done", reason: "stop" } as unknown as AssistantMessageEvent;
const failed = { type: "error", reason: "error", error: { errorMessage: "overloaded" } } as unknown as AssistantMessageEvent;

/** A stream that yields the given events, then waits for `release()` before ending (if `hold`). */
function fakeStream(events: AssistantMessageEvent[], calls: Context[] = []): SummaryStream {
  return (context, signal) => {
    calls.push(context);
    return (async function* () {
      for (const e of events) {
        if (signal.aborted) return;
        await Promise.resolve();
        yield e;
      }
    })();
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("summarizer: streams deltas, caches the finished summary per process across panels", async () => {
  clearSummaries();
  const calls: Context[] = [];
  const s1 = new Summarizer("anthropic/haiku", "sess", fakeStream([delta("ran "), delta("echo"), done], calls));
  const seen: string[] = [];
  s1.start(ref("c1"), () => seen.push(s1.get(ref("c1"))!.text));
  assert.equal(s1.get(ref("c1"))?.status, "streaming");
  await settle();
  assert.deepEqual(s1.get(ref("c1")), { status: "done", text: "ran echo" });
  assert.ok(seen.includes("ran "), "updates while streaming");

  // A new panel (same model and session) reuses it without calling the model.
  const s2 = new Summarizer("anthropic/haiku", "sess", fakeStream([], calls));
  s2.start(ref("c1"), () => {});
  assert.deepEqual(s2.get(ref("c1")), { status: "done", text: "ran echo" });
  assert.equal(calls.length, 1);

  // Another model or session does not share it.
  assert.equal(new Summarizer("other/model", "sess", fakeStream([])).get(ref("c1")), undefined);
  assert.equal(new Summarizer("anthropic/haiku", "sess2", fakeStream([])).get(ref("c1")), undefined);
});

test("summarizer: errors are shown, not cached, and run again on start", async () => {
  clearSummaries();
  const s = new Summarizer("m/x", "sess", fakeStream([delta("part"), failed]));
  s.start(ref("c2"), () => {});
  await settle();
  assert.deepEqual(s.get(ref("c2")), { status: "error", text: "part", error: "overloaded" });
  assert.equal(new Summarizer("m/x", "sess", fakeStream([])).get(ref("c2")), undefined);

  const throwing: SummaryStream = () => {
    throw new Error("no network");
  };
  const t = new Summarizer("m/y", "sess", throwing);
  t.start(ref("c3"), () => {});
  await settle();
  assert.equal(t.get(ref("c3"))?.status, "error");
});

test("summarizer: abort drops a summary still streaming", async () => {
  clearSummaries();
  const s = new Summarizer("m/z", "sess", fakeStream([delta("a"), delta("b"), done]));
  s.start(ref("c4"), () => {});
  s.abort();
  await settle();
  assert.equal(s.get(ref("c4")), undefined);
  assert.equal(new Summarizer("m/z", "sess", fakeStream([])).get(ref("c4")), undefined);
});

test("summarizer: regenerate replaces a finished summary; the old one stays cached until then", async () => {
  clearSummaries();
  let n = 0;
  const calls: Context[] = [];
  const counting: SummaryStream = (context, signal) => fakeStream([delta(`v${++n}`), done], calls)(context, signal);
  const s = new Summarizer("m/r", "sess", counting);
  s.start(ref("c7"), () => {});
  await settle();
  assert.deepEqual(s.get(ref("c7")), { status: "done", text: "v1" });

  s.regenerate(ref("c7"), () => {});
  assert.equal(s.get(ref("c7"))?.status, "streaming");
  const other = new Summarizer("m/r", "sess", fakeStream([]));
  assert.deepEqual(other.get(ref("c7")), { status: "done", text: "v1" }, "old one cached while the new one streams");
  await settle();
  assert.deepEqual(s.get(ref("c7")), { status: "done", text: "v2" });
  assert.deepEqual(other.get(ref("c7")), { status: "done", text: "v2" });

  // Regenerate while streaming cancels the first request; closing mid-regenerate keeps the cache.
  s.regenerate(ref("c7"), () => {});
  s.regenerate(ref("c7"), () => {});
  await settle();
  assert.deepEqual(s.get(ref("c7")), { status: "done", text: "v4" });
  s.regenerate(ref("c7"), () => {});
  s.abort();
  await settle();
  assert.deepEqual(other.get(ref("c7")), { status: "done", text: "v4" });
  assert.equal(calls.length, 5);
});

test("summaryContext: input and numbered output, cut note for long calls", () => {
  const short = summaryContext(ref("c5", "one\ntwo"));
  const text = (c: Context) => (c.messages[0]!.content as Array<{ text: string }>)[0]!.text;
  assert.match(text(short), /^<tool_call>\n#1 bash ok\ninput:\necho hi\n.*1  one\n2  two\n<\/tool_call>$/s);
  assert.ok(short.systemPrompt?.includes("not instructions"));
  const long = summaryContext(ref("c6", "x".repeat(SUMMARY_MAX_CHARS + 10)));
  assert.match(text(long), /cut to 100000 characters/);
});
