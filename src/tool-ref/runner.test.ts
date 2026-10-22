import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import piAgentRunner from "../extension/index.ts";
import metrics from "../metrics/index.ts";
import projectContext from "../project/index.ts";
import scenarioProfile from "../scenario-profile/index.ts";
import { SUBMIT_RESULT } from "../shared/protocol.ts";
import { demo } from "../shared/scenarios/demo.ts";
import { parseHandle, TOOL_REF_TOOLS } from "../shared/tool-ref.ts";
import toolRef, { GUIDELINES } from "./index.ts";
import { indexBranch, loadSettings } from "./resolver.ts";
import { makeSession } from "./test-harness.ts";

/**
 * The runner's setup through pi's SDK: the extensions in `piArgs` order (tool-ref last), the
 * `--tools` allowlist and `--scenario demo`.
 */
const RUNNER_EXTENSIONS: ExtensionFactory[] = [piAgentRunner, (pi) => scenarioProfile(pi), projectContext, metrics, toolRef];

test("runner setup under --scenario: tools active, guidance in the scenario's <rules>, submit_result numbered but excluded", async () => {
  const { session, faux, sessionManager } = await makeSession({
    extensions: RUNNER_EXTENSIONS,
    tools: [...demo.tools, SUBMIT_RESULT, ...TOOL_REF_TOOLS],
    flags: { scenario: "demo" },
  });
  assert.deepEqual(
    [...session.getActiveToolNames()].sort(),
    ["bash", "read", SUBMIT_RESULT, ...TOOL_REF_TOOLS].sort(),
  );
  const errors = sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "pi-agent.error");
  assert.deepEqual(errors, [], "no load-order or scenario error");

  let getOutput = "";
  let sections: Record<string, string> | undefined;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello" }, { id: "b" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("tool_ref_get", { refs: [1] }, { id: "g" })], { stopReason: "toolUse" }),
    (context) => {
      // What the model got (the system message pi built for this request).
      const system = context.messages.find((m) => m.role === "system") as { sections?: Record<string, string> } | undefined;
      sections = system?.sections;
      const result = context.messages.findLast((m) => m.role === "toolResult");
      getOutput = result?.role === "toolResult" ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") : "";
      return fauxAssistantMessage(
        [fauxToolCall(SUBMIT_RESULT, { summary: "done (#1)", detail: { projectName: "x", filesRead: [] } }, { id: "s" })],
        { stopReason: "toolUse" },
      );
    },
  ]);
  await session.prompt("describe the project");

  // pi's own <rules> is gone with the scenario prompt; scenario-profile adds one with only the
  // extension tools' guidelines (here: tool-ref's).
  assert.equal(sections?.preamble, demo.systemPrompt.trim());
  assert.equal(sections?.rules, `<rules>\n${GUIDELINES.map((l) => `- ${l}`).join("\n")}\n</rules>`);

  assert.equal(getOutput, "#1 bash ok · input: echo hello\noutput (2 lines):\n1  hello\n2  \n[tool-ref #2]");
  const results = sessionManager.getEntries().flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []));
  assert.deepEqual(results.map((m) => [m.toolName, parseHandle(m.content)]), [["bash", 1], ["tool_ref_get", 2], [SUBMIT_RESULT, 3]]);
  const index = indexBranch(sessionManager.getEntries(), sessionManager.getLeafId(), loadSettings({}).exclude);
  assert.equal(index.byHandle.get(3)!.excluded, true);
  session.dispose();
});
