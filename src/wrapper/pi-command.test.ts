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
    "--no-mcp",
    "-ns", "--skill", "/app/skills/shared", "--skill", "/app/skills/s/own",
    "-np", "-nc", "--no-themes", "-na", "--offline",
    "--session-dir", "/out/sessions",
    "--fork", "/prev.jsonl",
    "--tools", "read,bash,submit_result",
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
    skillPaths: [],
    sessionDir: "d",
  });
  for (const flag of ["--skill", "--fork", "--model", "--thinking", "--project"]) assert.ok(!args.includes(flag), flag);
});

test("shellQuote quotes only when needed", () => {
  assert.equal(shellQuote(["pi", "--tools", "a,b", "it's here", "a b"]), `pi --tools a,b 'it'\\''s here' 'a b'`);
});
