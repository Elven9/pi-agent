import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import piAgentRunner from "../extension/index.ts";
import metrics from "../metrics/index.ts";
import projectContext from "../project/index.ts";
import scenarioProfile from "../scenario-profile/index.ts";
import { SUBMIT_RESULT } from "../shared/protocol.ts";
import { demo } from "../shared/scenarios/demo.ts";
import { parseHandle, TOOL_REF_TOOLS } from "../shared/tool-ref.ts";
import toolRef, { CODEMODE_GUIDELINE, sectionText } from "./index.ts";
import { indexBranch, loadSettings } from "./resolver.ts";
import { makeSession } from "./test-harness.ts";

/**
 * The runner's setup through pi's SDK: pi's built-in codemode extension (the CLI loads built-ins
 * first), then the extensions in `piArgs` order (tool-ref last), the `--tools` allowlist,
 * `--scenario demo`, `--project` and `codemode.mode: "only"`.
 */
const RUNNER_EXTENSIONS: ExtensionFactory[] = [
  createCodemodeExtension({ models: false }),
  piAgentRunner,
  (pi) => scenarioProfile(pi),
  projectContext,
  metrics,
  toolRef,
];

type System = { sections?: Record<string, string>; toolsAdded?: Array<{ name: string; description: string }> };

test("runner setup, codemode only: scripts reach the tools, <tool_refs> in block A, rules without duplicates", async () => {
  const project = mkdtempSync(join(tmpdir(), "tool-ref-project-"));
  writeFileSync(join(project, "project.yaml"), "version: 1\nname: demo\n");
  const { session, faux, sessionManager } = await makeSession({
    extensions: RUNNER_EXTENSIONS,
    tools: [...demo.tools, SUBMIT_RESULT, ...TOOL_REF_TOOLS],
    flags: { scenario: "demo", project },
    settings: { codemode: { mode: "only" } },
  });
  assert.deepEqual(
    [...session.getActiveToolNames()].sort(),
    ["bash", "codemode", "read", SUBMIT_RESULT, ...TOOL_REF_TOOLS].sort(),
  );
  const errors = sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "pi-agent.error");
  assert.deepEqual(errors, [], "no load-order or scenario error");

  let system: System | undefined;
  let scriptOutput = "";
  faux.setResponses([
    (context) => {
      system = context.messages.find((m) => m.role === "system") as System | undefined;
      const code = 'const r = await tools.bash({ command: "echo hello" });\nreturn r.output;';
      return fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "c1" })], { stopReason: "toolUse" });
    },
    () => {
      const code = [
        "const got = await tools.tool_ref_get({ refs: [1] });",
        "let blocked = '';",
        "try { await tools.submit_result({ summary: 'x', detail: {} }); } catch (e) { blocked = e.message; }",
        "return { output: got.results[0].output, blocked };",
      ].join("\n");
      return fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "c2" })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.findLast((m) => m.role === "toolResult");
      scriptOutput = result?.role === "toolResult" ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") : "";
      return fauxAssistantMessage(
        [fauxToolCall(SUBMIT_RESULT, { summary: "hello (#1)", detail: { projectName: "x", filesRead: [] } }, { id: "s" })],
        { stopReason: "toolUse" },
      );
    },
  ]);
  await session.prompt("describe the project");

  const sections = system?.sections ?? {};
  // <tool_refs> comes first among the extension sections, so it is in block A (before the
  // project's sections) although tool-ref loads last.
  assert.deepEqual(Object.keys(sections).slice(-4), ["cwd", "tool_refs", "rules", "project"]);
  assert.equal(sections.tool_refs, `<tool_refs>\n${sectionText(true)}\n</tool_refs>`);
  assert.ok(sections.tool_refs.includes(CODEMODE_GUIDELINE), "codemode active: the intent rule is in <tool_refs>");
  // The scenario's <rules>: codemode's own guideline only. tool-ref has none; read and bash are
  // built-in and hidden (only scripts call them).
  assert.match(sections.rules!, /^<rules>\n- Use codemode to [^\n]*\n<\/rules>$/);

  // Declared to the model: codemode and submit_result. Scripts reach the others, not submit_result.
  assert.deepEqual(system?.toolsAdded?.map((t) => t.name).sort(), ["codemode", SUBMIT_RESULT]);
  const description = system!.toolsAdded!.find((t) => t.name === "codemode")!.description;
  for (const name of ["read", "bash", ...TOOL_REF_TOOLS]) assert.ok(description.includes(`### \`${name}\``), name);
  assert.ok(!description.includes(`\`${SUBMIT_RESULT}\``));
  assert.ok(!description.includes("Cite"), "tool-ref guidance is not repeated in the codemode description");

  assert.match(scriptOutput, /"output":"Script completed\\n[^"]*hello\\n"/);
  assert.match(scriptOutput, /"blocked":"[^"]+"/);
  const results = sessionManager.getEntries().flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []));
  assert.deepEqual(results.map((m) => [m.toolName, parseHandle(m.content)]), [["codemode", 1], ["codemode", 2], [SUBMIT_RESULT, 3]]);
  const index = indexBranch(sessionManager.getEntries(), sessionManager.getLeafId(), loadSettings({}).exclude);
  assert.equal(index.byHandle.get(3)!.excluded, true);
  session.dispose();
});
