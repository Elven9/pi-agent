import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HandleCounter } from "./counter.ts";
import toolRef from "./index.ts";
import { TestSession } from "./test-session.ts";
import { parseHandle } from "../shared/tool-ref.ts";

const sessionOf = (s: TestSession, id = "s1") => ({ getSessionId: () => id, getEntries: () => s.entries, getLeafId: () => s.leafId });

test("new session starts at 1; distinct numbers per take", () => {
  const counter = new HandleCounter(new Map());
  const s = sessionOf(new TestSession());
  assert.deepEqual([counter.take(s), counter.take(s), counter.take(s)], [1, 2, 3]);
});

test("continues after the file max, over all branches (new branch after /tree)", () => {
  const t = new TestSession();
  const root = t.user("go");
  t.calls({ id: "a", tool: "bash", handle: 7 });
  t.branchFrom(root);
  t.calls({ id: "b", tool: "bash", handle: 2 });
  assert.equal(new HandleCounter(new Map()).take(sessionOf(t)), 8);
});

test("reload race: the new instance continues from numbers the old one handed out but did not persist", () => {
  const shared = new Map<string, number>();
  const t = new TestSession();
  t.calls({ id: "a", tool: "bash", handle: 1 });
  const old = new HandleCounter(shared);
  assert.equal(old.take(sessionOf(t)), 2); // not in the file yet
  // New instance, first result before its session_start: lazy init from file max and the global next.
  const fresh = new HandleCounter(shared);
  assert.equal(fresh.take(sessionOf(t)), 3);
  // Counters are per session id.
  assert.equal(fresh.take(sessionOf(new TestSession(), "other")), 1);
});

/** The extension with a fake pi: returns the message_end handler and the registered tools. */
function loadExtension() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const tools: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.set(event, handler),
    registerTool: (tool: { name: string }) => void tools.push(tool.name),
    registerToolRenderer() {},
    getSettings: () => ({}),
    events: { on() {}, emit() {} },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  // A process-global counter is shared by instances; use a fresh session id per test.
  const t = new TestSession();
  const notices: Array<[string, string]> = [];
  const ctx = {
    sessionManager: sessionOf(t, `s-${Math.random()}`),
    ui: { notify: (message: string, type: string) => void notices.push([message, type]) },
  };
  toolRef(pi);
  return {
    end: (message: object) => handlers.get("message_end")!({ type: "message_end", message }, ctx),
    tools,
    session: t,
    /** Runs `/ref <args>` and returns the notification. */
    ref: async (args: string) => (await commands.get("ref")!.handler(args, ctx), notices.at(-1)!),
  };
}

test("message_end: toolResult only, own block at the end, other fields kept, once", () => {
  const { end, tools } = loadExtension();
  assert.deepEqual(tools, ["tool_ref_get", "tool_ref_grep"]);
  for (const role of ["user", "assistant", "custom", "system"]) assert.equal(end({ role, content: [] }), undefined);
  const message = { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "out\n" }], details: { x: 1 }, isError: false, timestamp: 5 };
  const result = end(message);
  assert.deepEqual(result.message, { ...message, content: [{ type: "text", text: "out\n" }, { type: "text", text: "[tool-ref #1]" }] });
  assert.equal(message.content.length, 1, "original not mutated");
  // A repeated message_end does not number twice.
  assert.equal(end(result.message), undefined);
  // Images and empty content get the text block too.
  assert.equal(parseHandle(end({ ...message, content: [{ type: "image", data: "…", mimeType: "image/png" }] }).message.content), 2);
  assert.deepEqual(end({ ...message, content: [] }).message.content, [{ type: "text", text: "[tool-ref #3]" }]);
  // Output that only ends with a trailer line is numbered.
  assert.equal(parseHandle(end({ ...message, content: [{ type: "text", text: "x\n[tool-ref #1]" }] }).message.content), 4);
});

test("/ref command: shows the call from the session, usage error on bad arguments", async () => {
  const { ref, session } = loadExtension();
  session.calls({ id: "c1", tool: "bash", input: { command: "echo hi" }, output: "hi", handle: 1 });
  const [text, type] = await ref("#1");
  assert.equal(type, "info");
  assert.match(text, /^──── #1 bash ok ────\ncall c1 · .*\n\ninput:\necho hi\n\noutput \(1 line\):\n1  hi$/);
  assert.deepEqual(await ref("nope"), ["Usage: /ref <N> [N ...], e.g. /ref 12 or /ref #12 #14", "error"]);
});
