import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseHandle } from "../shared/tool-ref.ts";
import toolRef, { GUIDELINES } from "./index.ts";
import { makeSession as makeHarnessSession, type TestSessionOptions } from "./test-harness.ts";

/**
 * End to end through pi's SDK with the faux provider: tool-ref numbers every kind of result
 * pi creates, the saved entries and the model context carry the trailer, and the tools read
 * it back.
 */

/** Test tools and a tool_call gate, loaded before tool-ref. */
function probe(pi: ExtensionAPI) {
  for (const name of ["submit_result", "throws"]) {
    pi.registerTool({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      async execute() {
        if (name === "throws") throw new Error("boom from execute");
        return { content: [{ type: "text", text: "Result recorded." }], details: {} };
      },
    });
  }
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && String((event.input as { command?: string }).command).includes("BLOCK")) {
      return { block: true, reason: "blocked by probe" };
    }
  });
}

const TOOLS = ["read", "bash", "throws", "submit_result", "tool_ref_get", "tool_ref_grep"];

function makeSession(opts: Partial<TestSessionOptions> = {}) {
  return makeHarnessSession({ extensions: [probe, toolRef], tools: TOOLS, ...opts });
}

/** toolCallId → handle of the saved results, in file order. */
function savedHandles(sm: SessionManager): Array<[string, number | undefined]> {
  return sm
    .getEntries()
    .flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [[e.message.toolCallId, parseHandle(e.message.content)]] : [])) as Array<
    [string, number | undefined]
  >;
}

function resultText(sm: SessionManager, toolCallId: string): string {
  for (const e of sm.getEntries()) {
    if (e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === toolCallId) {
      return e.message.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    }
  }
  throw new Error(`no result ${toolCallId}`);
}

const call = (name: string, args: object, id: string) => fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id });

test("every result gets a trailer in call order: tools, errors, blocked, unknown, invalid args, length cut", async () => {
  const { session, faux, sessionManager } = await makeSession();
  let seenByModel = "";
  const execEnd: string[] = [];
  session.subscribe((ev) => {
    if (ev.type === "tool_execution_end" && parseHandle(ev.result?.content) !== undefined) execEnd.push(ev.toolCallId);
  });
  const steps: FauxResponseStep[] = [
    fauxAssistantMessage(
      [
        call("bash", { command: "echo hi" }, "ok"),
        call("bash", { command: "echo BLOCK" }, "blocked"),
        call("throws", {}, "throws"),
        call("nosuchtool", {}, "unknown"),
        call("read", { nope: 1 }, "badargs"),
        call("read", { path: "/definitely/missing" }, "readerr"),
        call("submit_result", {}, "submit"),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([call("bash", { command: "echo cut" }, "cut")], { stopReason: "length" }),
    (context) => {
      seenByModel = JSON.stringify(context.messages.filter((m) => m.role === "toolResult").map((m) => m.content.at(-1)));
      return fauxAssistantMessage(fauxText("done"));
    },
  ];
  faux.setResponses(steps);
  await session.prompt("go");

  assert.deepEqual(savedHandles(sessionManager), [
    ["ok", 1],
    ["blocked", 2],
    ["throws", 3],
    ["unknown", 4],
    ["badargs", 5],
    ["readerr", 6],
    ["submit", 7],
    ["cut", 8],
  ]);
  // The trailer is its own block, after the tool's own output.
  assert.equal(resultText(sessionManager, "ok"), "hi\n\n[tool-ref #1]");
  assert.equal(resultText(sessionManager, "blocked"), "blocked by probe\n[tool-ref #2]");
  // The model got the trailers; tool_execution_end never has them.
  for (let n = 1; n <= 8; n++) assert.ok(seenByModel.includes(`[tool-ref #${n}]`), `model saw #${n}`);
  assert.deepEqual(execEnd, []);
  session.dispose();
});

test("tool_ref_get and tool_ref_grep read back calls; their own results are numbered but not shown", async () => {
  const { session, faux, sessionManager } = await makeSession();
  faux.setResponses([
    fauxAssistantMessage([call("bash", { command: "printf 'one\\ntwo\\nthree'" }, "b1"), call("submit_result", {}, "s1")], { stopReason: "toolUse" }),
    fauxAssistantMessage(
      [
        call("tool_ref_get", { refs: [1, 2, 9], lines: [2, 3] }, "g1"),
        call("tool_ref_grep", { pattern: "two|tool-ref", in: "output", tool: "bash" }, "r1"),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([call("tool_ref_get", { refs: [3, 4] }, "g2")], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  await session.prompt("go");

  assert.deepEqual(savedHandles(sessionManager).map(([, n]) => n), [1, 2, 3, 4, 5]);
  assert.equal(
    resultText(sessionManager, "g1"),
    [
      "#1 bash ok · input: printf 'one\\ntwo\\nthree'",
      "output lines 2-3 of 3:",
      "2  two",
      "3  three",
      "",
      "#2 is a submit_result call, which tool-ref does not show (toolRef.exclude)",
      "",
      "#9 is unknown (no tool result has this number)",
      "[tool-ref #3]",
    ].join("\n"),
  );
  // The trailer of #1 is not part of its output, so grep does not find it.
  assert.equal(resultText(sessionManager, "r1"), "#1 bash ok   printf 'one\\ntwo\\nthree'\n  out:2  two\n[tool-ref #4]");
  assert.match(resultText(sessionManager, "g2"), /^#3 is a tool_ref_get call.*\n\n#4 is a tool_ref_grep call/);
  session.dispose();
});

test("toolRef.exclude from settings; guidance in pi's <rules>", async () => {
  const { session, faux, sessionManager } = await makeSession({ settings: { toolRef: { exclude: ["throws"] } } });
  for (const line of GUIDELINES) assert.ok(session.systemPrompt.includes(line), line);
  faux.setResponses([
    fauxAssistantMessage([call("throws", {}, "t"), call("submit_result", {}, "s")], { stopReason: "toolUse" }),
    fauxAssistantMessage([call("tool_ref_get", { refs: [1, 2] }, "g")], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  await session.prompt("go");
  const out = resultText(sessionManager, "g");
  assert.match(out, /^#1 is a throws call, which tool-ref does not show/);
  // A project list replaces the default, so submit_result is readable now.
  assert.match(out, /#2 submit_result ok/);
  session.dispose();
});

test("numbering continues after a reload and in a resumed session (max of the file)", async () => {
  const first = await makeSession();
  first.faux.setResponses([
    fauxAssistantMessage([call("bash", { command: "echo a" }, "a"), call("bash", { command: "echo b" }, "b")], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  await first.session.prompt("go");
  await first.session.reload();
  first.faux.setResponses([
    fauxAssistantMessage([call("bash", { command: "echo c" }, "c")], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  await first.session.prompt("again");
  assert.deepEqual(savedHandles(first.sessionManager).map(([, n]) => n), [1, 2, 3]);
  const file = first.sessionManager.getSessionFile()!;
  first.session.dispose();

  // A fresh process state (no global counter for this id): the scan of the file decides.
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-agent.tool-ref")] = undefined;
  const resumed = await makeSession({ root: first.root, sessionManager: SessionManager.open(file) });
  resumed.faux.setResponses([
    fauxAssistantMessage([call("bash", { command: "echo d" }, "d")], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("done")),
  ]);
  await resumed.session.prompt("more");
  assert.deepEqual(savedHandles(resumed.sessionManager).map(([, n]) => n), [1, 2, 3, 4]);
  resumed.session.dispose();
});

test("the renderer resolver is registered with pi's runner", async () => {
  const { session } = await makeSession();
  let seen: unknown;
  const set = session.extensionRunner.resolveToolRenderers("bash", () => ({ renderResult: (r: unknown) => ((seen = r), {} as never) }));
  set!.renderResult!({ content: [{ type: "text", text: "x" }, { type: "text", text: "[tool-ref #1]" }], details: {} }, { expanded: false, isPartial: false }, {} as never, {} as never);
  assert.deepEqual(seen, { content: [{ type: "text", text: "x" }], details: {} });
  session.dispose();
});

/** The run of the first test: every kind of result pi creates. */
function allKindsOfResults(): FauxResponseStep[] {
  return [
    fauxAssistantMessage(
      [
        call("bash", { command: "echo hi" }, "ok"),
        call("bash", { command: "echo BLOCK" }, "blocked"),
        call("throws", {}, "throws"),
        call("nosuchtool", {}, "unknown"),
        call("read", { nope: 1 }, "badargs"),
        call("tool_ref_grep", { pattern: "hi" }, "grep"),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([call("bash", { command: "echo cut" }, "cut")], { stopReason: "length" }),
    fauxAssistantMessage(fauxText("done")),
  ];
}

test("report.json tool log from the event stream: ref for every call, output without trailer", async () => {
  const { ToolLog } = await import("../wrapper/tool-log.ts");
  const { session, faux, sessionManager } = await makeSession();
  const log = new ToolLog();
  // JSON mode prints toJsonEvent(event), which only changes message_update events.
  session.subscribe((event) => log.onRecord(JSON.parse(JSON.stringify(event))));
  faux.setResponses(allKindsOfResults());
  await session.prompt("go");

  const saved = new Map(savedHandles(sessionManager));
  const calls = log.entries();
  assert.deepEqual(calls.map((c) => c.id), ["ok", "blocked", "throws", "unknown", "badargs", "grep", "cut"]);
  for (const c of calls) {
    assert.equal(c.ref, saved.get(c.id), `ref of ${c.id}`);
    assert.ok(c.ref !== null, `${c.id} has a ref`);
    assert.doesNotMatch(c.output ?? "", /tool-ref #/, `output of ${c.id}`);
  }
  session.dispose();
});

test("HTML export: pre-rendered custom tool results have no trailer; the embedded data keeps it", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  // The CLI sets up pi's global theme in every mode; renderers (pi's and ours) need it.
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme(undefined, false);
  const { session, faux, root } = await makeSession();
  faux.setResponses(allKindsOfResults());
  await session.prompt("go");
  const file = await session.exportToHtml(join(root, "export.html"));
  const html = await readFile(file, "utf8");
  const raw = /<script id="session-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1].trim();
  const data = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  // Custom tools (throws: no renderResult, our fallback; tool_ref_grep) are drawn by renderers.
  for (const id of ["throws", "grep"]) {
    const rendered = JSON.stringify(data.renderedTools[id]);
    assert.ok(rendered && rendered.includes("result"), `${id} pre-rendered`);
    assert.doesNotMatch(rendered, /tool-ref #/, `${id} without trailer`);
  }
  assert.match(JSON.stringify(data.renderedTools.throws), /boom from execute/);
  // Built-in tools are left to the template, which draws them from the raw content.
  assert.equal(data.renderedTools.ok?.resultHtmlExpanded, undefined);
  assert.match(JSON.stringify(data.entries), /\[tool-ref #1\]/);
  session.dispose();
});

test("offline index of the session file equals the live index; /tree navigation without an entry", async () => {
  const { readFileSync } = await import("node:fs");
  const { indexBranch, indexSessionFile } = await import("./resolver.ts");
  const { session, faux, sessionManager } = await makeSession();
  faux.setResponses(allKindsOfResults());
  await session.prompt("go");
  faux.setResponses([fauxAssistantMessage([call("bash", { command: "echo later" }, "later")], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))]);
  await session.prompt("more");

  const file = sessionManager.getSessionFile()!;
  const live = () => indexBranch(sessionManager.getEntries(), sessionManager.getLeafId(), ["submit_result"]);
  const offline = () => indexSessionFile(readFileSync(file, "utf8"), ["submit_result"]);
  assert.equal(live().refs.length, 8);
  assert.deepEqual(offline(), live());

  // Go back to before the second prompt: the live leaf moves, the file is unchanged, so
  // the offline index still ends at "later" (what --resume would continue).
  const beforeLater = sessionManager.getBranch().findIndex((e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("more"));
  sessionManager.branch(sessionManager.getBranch()[beforeLater - 1].id);
  assert.equal(live().byToolCallId.has("later"), false);
  assert.equal(offline().byToolCallId.has("later"), true);
  assert.equal(live().byHandle.has(8), false);

  // The next entry makes file and live leaf agree again.
  faux.setResponses([fauxAssistantMessage([call("bash", { command: "echo branch" }, "branch")], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))]);
  await session.prompt("other way");
  assert.deepEqual(offline(), live());
  // The new branch continues after the file max (#8 is on the abandoned branch).
  assert.equal(live().byToolCallId.get("branch")!.handle, 9);
  session.dispose();
});
