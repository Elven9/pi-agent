import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../shared/project.ts";
import { getScenario } from "../shared/scenarios/index.ts";
import type { Task } from "../shared/task.ts";
import { runTask, type RunOptions } from "./run.ts";

// Wrapper end to end against testdata/fake-pi.mjs, which replays a recorded pi 1.3.0 run
// (testdata/demo-run.*: the demo scenario calling bash, read and submit_result).
// Re-record the fixtures when updating pi (see README).

const testdata = fileURLToPath(new URL("../../testdata/", import.meta.url));
const fakePi = join(testdata, "fake-pi.mjs");
const task: Task = { taskId: "t-1", scenario: "demo", prompt: "go" };

type RunExtras = Partial<Pick<RunOptions, "project" | "warnings">> & {
  signal?: AbortSignal;
  piBin?: string;
  /** Files written into the workdir before the run. */
  files?: Record<string, string>;
};

async function run(env: Record<string, string>, opts: RunExtras = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-run-"));
  for (const [name, content] of Object.entries(opts.files ?? {})) await writeFile(join(dir, name), content);
  const argsFile = join(dir, "args.json");
  for (const k of ["FAKE_PI_EVENTS", "FAKE_PI_SESSION", "FAKE_PI_STDERR", "FAKE_PI_EXIT", "FAKE_PI_HANG"]) delete process.env[k];
  Object.assign(process.env, { FAKE_PI_ARGS: argsFile }, env);
  const report = await runTask({
    task,
    scenario: getScenario("demo"),
    workdir: dir,
    out: join(dir, "out"),
    piBin: opts.piBin ?? fakePi,
    extensionPath: "/app/dist/extension.js",
    scenarioProfileExtensionPath: "/app/dist/scenario-profile.js",
    projectExtensionPath: "/app/dist/project.js",
    metricsExtensionPath: "/app/dist/metrics.js",
    skillPaths: [],
    project: opts.project,
    warnings: opts.warnings,
    signal: opts.signal,
    log: () => {},
  });
  const args = JSON.parse(await readFile(argsFile, "utf8").catch(() => "null"));
  return { report, args, dir };
}

/** JSONL fixture from records. */
async function events(...records: object[]): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "pi-agent-ev-")), "events.jsonl");
  await writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
const header = { type: "session", version: 3, id: "s-1", timestamp: "", cwd: "/w" };
const assistant = (extra: object) => ({ type: "message_end", message: { role: "assistant", content: [], ...extra } });

test("recorded demo run: ok with result, tool calls, usage and session file", async () => {
  const { report, args } = await run({
    FAKE_PI_EVENTS: join(testdata, "demo-run.events.jsonl"),
    FAKE_PI_SESSION: join(testdata, "demo-run.session.jsonl"),
  });
  assert.equal(args[args.indexOf("--scenario") + 1], "demo");
  assert.equal(report.status, "ok", JSON.stringify(report.errors));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.result, {
    summary:
      "pi-agent is a pi package that provides resources (skills, prompts) and a sandbox runner combining the stock pi CLI with extensions and a wrapper that generates report.json.",
    detailKind: "demo/v1",
    detail: { projectName: "pi-agent", filesRead: ["package.json"] },
  });
  assert.deepEqual(
    report.toolCalls.map((c) => [c.tool, c.turn, c.isError]),
    [["bash", 1, false], ["read", 2, false], ["submit_result", 3, false]],
  );
  const m = report.metrics;
  assert.deepEqual(m.tokens, { input: 5612, output: 602, cacheRead: 0, cacheWrite: 0 });
  assert.equal(m.costUsd, 0.008622);
  assert.equal(m.turns, 3);
  assert.equal(m.model.calls, 3);
  assert.equal(m.contextPeakPercent, 1);
  assert.deepEqual(m.cacheMisses, []); // prompt below Haiku's minimum cacheable length
  assert.equal(report.projectContext, null);
  assert.ok(!args.includes("--project"));
  assert.deepEqual(Object.keys(m.tools).sort(), ["bash", "read", "submit_result"]);
  assert.deepEqual(report.session, {
    id: "01a14a10-aef5-74b5-bb5f-ee5f99124061",
    file: "sessions/2026-01-01T00-00-00-000Z_01a14a10-aef5-74b5-bb5f-ee5f99124061.jsonl",
  });
});

test("project context: passed to pi and described in the report", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-agent-proj-"));
  await writeFile(join(projectDir, "project.yaml"), "version: 1\nname: billing\nrules: [Be careful.]\n");
  const project = await loadProject(projectDir);
  const file = await events(header, { type: "agent_start" });
  const { report, args } = await run(
    { FAKE_PI_EVENTS: file },
    { project, warnings: ["from input"], files: { "AGENTS.md": "Use pnpm.\n" } },
  );
  assert.equal(args[args.indexOf("--project") + 1], projectDir);
  assert.deepEqual(args.slice(args.indexOf("-ne"), args.indexOf("-ne") + 7), [
    "-ne", "-e", "/app/dist/extension.js", "-e", "/app/dist/scenario-profile.js", "-e", "/app/dist/project.js",
  ]);
  const ctx = report.projectContext!;
  assert.equal(ctx.dir, projectDir);
  assert.equal(ctx.name, "billing");
  assert.deepEqual(ctx.sections, ["project", "project_rules", "agents_md"]);
  assert.match(ctx.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.warnings, ["from input"]);
});

test("AGENTS.md alone is project context; a large block B is a warning", async () => {
  const file = await events(header, { type: "agent_start" });
  const { report } = await run({ FAKE_PI_EVENTS: file }, { files: { "AGENTS.md": "x".repeat(40_000) } });
  assert.equal(report.projectContext?.dir, null);
  assert.equal(report.projectContext?.name, null);
  assert.deepEqual(report.projectContext?.sections, ["agents_md"]);
  assert.match(report.warnings[0], /^project context is ~\d+ tokens \(over 8000\)/);
});

test("no submit_result: no_result", async () => {
  const file = await events(header, { type: "agent_start" }, { type: "turn_start" }, assistant({ stopReason: "stop" }));
  const { report } = await run({ FAKE_PI_EVENTS: file });
  assert.equal(report.status, "no_result");
  assert.deepEqual(report.errors, []);
  assert.equal(report.session?.file, null);
});

test("model error without a result: error, with the model's message", async () => {
  const file = await events(header, { type: "agent_start" }, assistant({ stopReason: "error", errorMessage: "529 overloaded" }));
  const { report } = await run({ FAKE_PI_EVENTS: file });
  assert.equal(report.status, "error");
  assert.deepEqual(report.errors, [{ phase: "run", message: "529 overloaded" }]);
});

test("invalid submitted result: error in validate", async () => {
  const file = await events(header, { type: "agent_start" }, {
    type: "tool_execution_end",
    toolCallId: "c",
    toolName: "submit_result",
    isError: false,
    result: { content: [], details: { summary: "s", detailKind: "demo/v1", detail: {} } },
  });
  const { report } = await run({ FAKE_PI_EVENTS: file });
  assert.equal(report.status, "error");
  assert.equal(report.errors[0].phase, "validate");
  assert.match(report.errors[0].message, /submitted result is invalid/);
});

test("pi fails at startup: error with pi's stderr", async () => {
  const { report } = await run({ FAKE_PI_EXIT: "1", FAKE_PI_STDERR: "noise\nUnknown model: x/y\n" });
  assert.equal(report.status, "error");
  assert.deepEqual(report.errors, [{ phase: "setup", message: "pi exited with code 1: noise\nUnknown model: x/y" }]);
  assert.equal(report.session, null);
});

test("pi exits 0 before the agent starts: error", async () => {
  const { report } = await run({ FAKE_PI_EVENTS: await events(header) });
  assert.equal(report.status, "error");
  assert.match(report.errors[0].message, /pi exited before the agent started/);
});

test("pi cannot be started: error", async () => {
  const { report } = await run({}, { piBin: "/nonexistent/pi" });
  assert.equal(report.status, "error");
  assert.match(report.errors[0].message, /cannot run \/nonexistent\/pi: .*ENOENT/);
});

test("abort stops pi and reports an error", async () => {
  const controller = new AbortController();
  const file = await events(header, { type: "agent_start" });
  setTimeout(() => controller.abort(), 300);
  const { report } = await run({ FAKE_PI_EVENTS: file, FAKE_PI_HANG: "1" }, { signal: controller.signal });
  assert.equal(report.status, "error");
  assert.deepEqual(report.errors, [{ phase: "run", message: "interrupted; pi was stopped" }]);
});
