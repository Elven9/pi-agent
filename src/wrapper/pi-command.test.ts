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
  skillPaths: ["skills/foo"],
  detailSchema: Type.Object({}),
});

test("piArgs loads nothing implicitly and passes the scenario profile", () => {
  const args = piArgs({
    task: { taskId: "t", scenario: "s", prompt: "-starts with a dash", model: "cpa/m", thinkingLevel: "low" },
    scenario,
    extensionPath: "/app/dist/extension.js",
    rootDir: "/app",
    sessionDir: "/out/sessions",
    resumeFrom: "/prev.jsonl",
  });
  assert.deepEqual(args, [
    "--mode", "json",
    "-ne", "-e", "/app/dist/extension.js",
    "--no-mcp",
    "-ns", "--skill", "/app/skills/foo",
    "-np", "-nc", "--no-themes", "-na", "--offline",
    "--session-dir", "/out/sessions",
    "--fork", "/prev.jsonl",
    "--tools", "read,bash,submit_result",
    "--model", "cpa/m",
    "--thinking", "low",
    "--system-prompt", "Be brief.",
    "--scenario", "s",
    "--", "-starts with a dash",
  ]);
});

test("piArgs omits optional flags", () => {
  const args = piArgs({
    task: { taskId: "t", scenario: "s", prompt: "p" },
    scenario: { ...scenario, skillPaths: undefined },
    extensionPath: "e.js",
    rootDir: "/app",
    sessionDir: "d",
  });
  for (const flag of ["--skill", "--fork", "--model", "--thinking"]) assert.ok(!args.includes(flag), flag);
});

test("shellQuote quotes only when needed", () => {
  assert.equal(shellQuote(["pi", "--tools", "a,b", "it's here", "a b"]), `pi --tools a,b 'it'\\''s here' 'a b'`);
});
