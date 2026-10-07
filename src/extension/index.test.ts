import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piAgentRunner from "./index.ts";
import { ENTRY, RESUBMIT_PROMPT } from "../shared/protocol.ts";
import { SUBMIT_PARAMETERS } from "../shared/result.ts";

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
function fakePi(flags: Record<string, string | undefined>, branch: object[] = []) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const tools: ToolDefinition[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  let percent: number | null = null;
  let shutdown = false;
  const pi = {
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => void tools.push(tool),
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }),
    shutdown: () => (shutdown = true),
    sessionManager: { getBranch: () => branch },
  };
  piAgentRunner(pi);
  return {
    tools,
    entries,
    get shutdown() {
      return shutdown;
    },
    setPercent: (p: number | null) => (percent = p),
    emit: (name: string, event: object = {}) => handlers.get(name)?.({ type: name, ...event }, ctx),
  };
}

const call = (tool: ToolDefinition, params: unknown) =>
  tool.execute("id", params as never, undefined, undefined, undefined as never);

test("is inert without --scenario", () => {
  const pi = fakePi({});
  pi.emit("session_start");
  assert.equal(pi.tools.length, 0);
  assert.equal(pi.emit("agent_before_settle", { outcome: "completed" }), undefined);
});

test("unknown scenario: records an error entry and shuts down", () => {
  const pi = fakePi({ scenario: "nope" });
  pi.emit("session_start");
  assert.equal(pi.tools.length, 0);
  assert.equal(pi.shutdown, true);
  assert.equal(pi.entries[0].customType, ENTRY.error);
  assert.match((pi.entries[0].data as { message: string }).message, /Unknown scenario/);
});

test("submit_result keeps the last valid call and rejects invalid ones", async () => {
  const pi = fakePi({ scenario: "demo" });
  pi.emit("session_start");
  const [tool] = pi.tools;
  assert.equal(tool.name, "submit_result");

  await call(tool, { summary: "first", detail: { projectName: "x", filesRead: [] } });
  const res = await call(tool, { summary: "second", detail: { projectName: "y", filesRead: ["package.json"] } });
  await assert.rejects(call(tool, { summary: "bad", detail: { projectName: 1 } }), /Invalid result:\n\/detail/);

  const expected = { summary: "second", detailKind: "demo/v1", detail: { projectName: "y", filesRead: ["package.json"] } };
  assert.deepEqual(res.details, expected);
  assert.equal(res.terminate, true);
});

test("submit_result has the same parameters in every scenario", () => {
  const pi = fakePi({ scenario: "demo" });
  pi.emit("session_start");
  assert.equal(pi.tools[0].parameters, SUBMIT_PARAMETERS);
});

test("sends the result format once, after the task prompt", () => {
  const pi = fakePi({ scenario: "demo" });
  assert.equal(pi.emit("before_agent_start"), undefined); // before session_start: inert
  pi.emit("session_start");
  const { message } = pi.emit("before_agent_start");
  assert.equal(message.customType, ENTRY.resultFormat);
  assert.match(message.content, /demo\/v1/);
  assert.match(message.content, /"filesRead"/);

  const resumed = fakePi({ scenario: "demo" }, [{ type: "custom_message", customType: ENTRY.resultFormat }]);
  resumed.emit("session_start");
  assert.equal(resumed.emit("before_agent_start"), undefined);
});

test("nudges once without a result, then records metrics", () => {
  const pi = fakePi({ scenario: "demo" });
  pi.emit("session_start");

  pi.setPercent(12.4);
  pi.emit("message_end", { message: { role: "assistant" } });
  pi.setPercent(50); // user messages are not sampled
  pi.emit("message_end", { message: { role: "user" } });
  pi.setPercent(30.6);
  pi.emit("session_compact");

  const first = pi.emit("agent_before_settle", { outcome: "completed" });
  assert.equal(first.continue, true);
  assert.deepEqual(first.entries, [
    { type: "custom_message", customType: ENTRY.resubmit, content: RESUBMIT_PROMPT, display: true },
  ]);

  const second = pi.emit("agent_before_settle", { outcome: "completed" });
  assert.equal(second.continue, undefined);
  assert.deepEqual(second.entries, [{ type: "custom", customType: ENTRY.metrics, data: { contextPeakPercent: 31 } }]);
});

test("does not nudge after a valid result or a failed run", async () => {
  const withResult = fakePi({ scenario: "demo" });
  withResult.emit("session_start");
  await call(withResult.tools[0], { summary: "s", detail: { projectName: "x", filesRead: [] } });
  assert.equal(withResult.emit("agent_before_settle", { outcome: "completed" }).continue, undefined);

  const failed = fakePi({ scenario: "demo" });
  failed.emit("session_start");
  const r = failed.emit("agent_before_settle", { outcome: "error" });
  assert.equal(r.continue, undefined);
  assert.deepEqual(r.entries[0].data, { contextPeakPercent: null });
});
