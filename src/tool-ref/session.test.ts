import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseHandle } from "../shared/tool-ref.ts";
import toolRef, { GUIDELINES } from "./index.ts";

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

async function makeSession(opts: { settings?: object; sessionManager?: SessionManager; root?: string } = {}) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "tool-ref-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (opts.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(opts.settings));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [probe, toolRef],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = opts.sessionManager ?? SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    tools: ["read", "bash", "throws", "submit_result", "tool_ref_get", "tool_ref_grep"],
  });
  await session.bindExtensions({});
  return { session, faux, sessionManager, root };
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
