import { test } from "node:test";
import assert from "node:assert/strict";
import { defineScenario } from "../shared/scenarios/index.ts";
import { Type } from "typebox";
import { piArgs, shellQuote } from "./pi-command.ts";

const scenario = defineScenario({
  name: "s",
  detailKind: "s/v1",
  systemPrompt: "Be brief.",
  tools: ["read", "bash"],
  detailSchema: Type.Object({}),
});

test("piArgs loads nothing implicitly and passes the scenario profile", () => {
  const args = piArgs({
    task: { taskId: "t", scenario: "s", prompt: "-starts with a dash", model: "cpa/m", thinkingLevel: "low" },
    scenario,
    extensionPath: "/app/dist/extension.js",
    scenarioProfileExtensionPath: "/app/dist/scenario-profile.js",
    projectExtensionPath: "/app/dist/project.js",
    metricsExtensionPath: "/app/dist/metrics.js",
    toolRefExtensionPath: "/app/dist/tool-ref.js",
    projectDir: "/project",
    skillPaths: ["/app/skills/shared", "/app/skills/s/own"],
    sessionDir: "/out/sessions",
    resumeFrom: "/prev.jsonl",
  });
  assert.deepEqual(args, [
    "--mode", "json",
    "-ne",
    "-e", "/app/dist/extension.js", "-e", "/app/dist/scenario-profile.js",
    "-e", "/app/dist/project.js", "-e", "/app/dist/metrics.js",
    "-e", "/app/dist/tool-ref.js",
    "--no-mcp",
    "-ns", "--skill", "/app/skills/shared", "--skill", "/app/skills/s/own",
    "-np", "-nc", "--no-themes", "-na", "--offline",
    "--session-dir", "/out/sessions",
    "--fork", "/prev.jsonl",
    "--tools", "read,bash,submit_result,tool_ref_get,tool_ref_grep",
    "--model", "cpa/m",
    "--thinking", "low",
    "--scenario", "s",
    "--project", "/project",
    "--", "-starts with a dash",
  ]);
});

test("piArgs omits optional flags", () => {
  const args = piArgs({
    task: { taskId: "t", scenario: "s", prompt: "p" },
    scenario,
    extensionPath: "e.js",
    scenarioProfileExtensionPath: "s.js",
    projectExtensionPath: "p.js",
    metricsExtensionPath: "m.js",
    toolRefExtensionPath: "t.js",
    skillPaths: [],
    sessionDir: "d",
  });
  for (const flag of ["--skill", "--fork", "--model", "--thinking", "--project"]) assert.ok(!args.includes(flag), flag);
});

test("shellQuote quotes only when needed", () => {
  assert.equal(shellQuote(["pi", "--tools", "a,b", "it's here", "a b"]), `pi --tools a,b 'it'\\''s here' 'a b'`);
});

test("piArgs loads tool-ref last and allows its tools", () => {
  const args = piArgs({
    task: { taskId: "t", scenario: "s", prompt: "p" },
    scenario,
    extensionPath: "e.js",
    scenarioProfileExtensionPath: "s.js",
    projectExtensionPath: "p.js",
    metricsExtensionPath: "m.js",
    toolRefExtensionPath: "t.js",
    skillPaths: [],
    sessionDir: "d",
  });
  const extensions = args.flatMap((a, i) => (a === "-e" ? [args[i + 1]] : []));
  assert.equal(extensions.at(-1), "t.js");
  const tools = args[args.indexOf("--tools") + 1].split(",");
  assert.ok(tools.includes("tool_ref_get") && tools.includes("tool_ref_grep"));
});

test("piArgs loads pi's built-in codemode (off with -ne) first when the scenario has the tool", () => {
  const base = {
    task: { taskId: "t", scenario: "s", prompt: "p" },
    extensionPath: "e.js",
    scenarioProfileExtensionPath: "s.js",
    projectExtensionPath: "p.js",
    metricsExtensionPath: "m.js",
    toolRefExtensionPath: "t.js",
    skillPaths: [],
    sessionDir: "d",
  };
  const extensions = (args: string[]) => args.flatMap((a, i) => (a === "-e" ? [args[i + 1]] : []));
  const withCodemode = piArgs({ ...base, scenario: { ...scenario, tools: ["codemode", "read"] } });
  assert.deepEqual(extensions(withCodemode), ["builtin:codemode", "e.js", "s.js", "p.js", "m.js", "t.js"]);
  assert.ok(withCodemode[withCodemode.indexOf("--tools") + 1].split(",").includes("codemode"));
  assert.ok(!extensions(piArgs({ ...base, scenario })).includes("builtin:codemode"));
});

test("piArgs adds project_read to --tools for a remote project only", () => {
  const base = {
    task: { taskId: "t", scenario: "s", prompt: "p" },
    scenario,
    extensionPath: "e.js",
    scenarioProfileExtensionPath: "s.js",
    projectExtensionPath: "p.js",
    metricsExtensionPath: "m.js",
    toolRefExtensionPath: "t.js",
    skillPaths: [],
    sessionDir: "d",
  };
  const tools = (args: string[]) => args[args.indexOf("--tools") + 1].split(",");
  const remote = piArgs({ ...base, projectRead: true });
  assert.ok(tools(remote).includes("project_read"));
  assert.ok(!remote.includes("--project"));
  assert.ok(!tools(piArgs(base)).includes("project_read"));
});
