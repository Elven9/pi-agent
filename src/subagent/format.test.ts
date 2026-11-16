import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatGet,
  formatGrep,
  grepResults,
  compilePattern,
  progressLine,
  resultContent,
  statusText,
  taskPrompt,
  widgetLines,
  type LiveView,
} from "./format.ts";
import { getScenario } from "../shared/scenarios/index.ts";
import type { ResultBody, ResultDetails } from "./protocol.ts";

const result = (id: number, body: Partial<ResultBody> = {}, extra: Partial<ResultDetails> = {}): ResultDetails => ({
  agentId: `a${id}`,
  resultId: `a${id}`,
  scenario: "review",
  kind: "task",
  task: "check the auth middleware\nfor token reuse",
  startedAt: Date.UTC(2026, 10, 13, 10, 0, 0),
  endedAt: Date.UTC(2026, 10, 13, 10, 2, 14),
  envelope: { v: 1, id: "m", from: `agent:a${id}`, to: "leader", kind: "result", ts: 0, body: { status: "ok", summary: "found one reuse bug", ...body } },
  ...extra,
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_400), "45s");
  assert.equal(formatDuration(134_000), "2m14s");
  assert.equal(formatDuration(3_720_000), "1h02m");
});

test("resultContent: header and summary; abnormal results also carry the task and the restart hint", () => {
  assert.equal(resultContent(result(3)), "[subagent a3] review · ok · 2m14s\nfound one reuse bug");
  const withDetail = resultContent(result(3, { detail: { x: 1 } }));
  assert.match(withDetail, /\(structured detail: subagent_get a3\)$/);
  const aborted = resultContent(result(5, { status: "aborted", reason: "leader_exit", summary: "aborted: the leader session ended" }, { project: "/p" }));
  assert.match(aborted, /^\[subagent a5\] review · aborted · 2m14s\naborted: the leader session ended\n\nTask \(review, project \/p\):\ncheck the auth middleware\nfor token reuse\n\nRestart it with subagent_restart/);
  assert.match(resultContent(result(6, { status: "killed", reason: "user", summary: "killed by user" })), /review · killed by user ·/);
  assert.match(resultContent(result(7, { status: "aborted", reason: "reload" })), /review · aborted \(reload\) ·/);
});

test("taskPrompt: the task, how to report, and the scenario's detail schema", () => {
  const scenario = getScenario("code-writer");
  const p = taskPrompt("a3", "fix it", scenario);
  assert.match(p, /^Task from your leader \(you are subagent a3, scenario code-writer\):\n\nfix it\n\nWhen you are done, call the send_to_leader tool exactly once:/);
  assert.ok(p.includes(`(${scenario.detailKind})`));
  assert.ok(p.includes(JSON.stringify(scenario.detailSchema, null, 2)));
  assert.match(taskPrompt("a1", "x", undefined), /- detail: optional structured result \(an object\)/);
});

test("progressLine: codemode intent, else tool and input summary, one line", () => {
  assert.equal(progressLine("codemode", { code: '// @options: {}\n// intent: list the tests\nreturn 1' }), "list the tests");
  assert.equal(progressLine("codemode", { code: "const x = 1;\nreturn x" }), "codemode const x = 1;…");
  assert.equal(progressLine("bash", { command: "rg foo\nmore" }), "bash rg foo…");
  assert.equal(progressLine("read", { path: "src/a.ts" }), "read src/a.ts");
});

const live = (id: string, state: string, scenario = "review"): LiveView => ({ id, scenario, state, task: "t", startedAt: 0, line: `${id} line`, progress: [] });

test("widgetLines and statusText", () => {
  assert.deepEqual(widgetLines([], 0), []);
  assert.deepEqual(widgetLines([live("a3", "busy"), live("a5", "spawning", "triage")], 80_000), [
    "● a3 review  busy      1m20s  a3 line",
    "◌ a5 triage  spawning  1m20s  a5 line",
  ]);
  const many = widgetLines(Array.from({ length: 7 }, (_, i) => live(`a${i + 1}`, "busy")), 0);
  assert.equal(many.length, 5);
  assert.equal(many[4], "+3 more (/agent)");
  assert.equal(statusText([]), undefined);
  assert.equal(statusText([live("a1", "busy"), live("a2", "busy"), live("a3", "spawning")]), "agents: 2 busy · 1 starting");
});

test("formatGet: numbered lines, ranges and the character cap", () => {
  const r = result(3, { detail: { bugs: 1 }, detailKind: "review/v1" });
  const all = formatGet(r);
  assert.match(all, /^──── a3 · review · ok · 2m14s \(\d+ lines\) ────\n 1  started 2026-11-13T10:00:00.000Z · ended 2026-11-13T10:02:14.000Z/);
  assert.match(all, /summary:\n\s*\d+  found one reuse bug/);
  assert.match(all, /detail \(review\/v1\):/);
  const part = formatGet(r, { lines: [3, 4] });
  assert.match(part, /\(lines 3-4 of \d+\) ────\n3  task:\n4  check the auth middleware$/);
  assert.match(formatGet(r, { maxChars: 100 }), /… cut at 100 chars/);
});

test("grep: newest first, case rule, context, caps", () => {
  const rs = [result(1, { summary: "Token reuse in login" }), result(2, { summary: "nothing found" })];
  const hits = grepResults(rs, compilePattern("token"));
  assert.deepEqual(hits.hits.map((h) => h.resultId), ["a2", "a1"], "the task mentions token in both");
  assert.equal(grepResults(rs, compilePattern("Token")).hits.length, 1, "uppercase: case-sensitive");
  const ctx = grepResults([rs[1]!], compilePattern("^nothing"), 1).hits[0]!.matches.map((m) => m.text);
  assert.deepEqual(ctx, ["summary:", "nothing found"]);
  assert.equal(formatGrep({ hits: [], omitted: 0 }), "No matches.");
  assert.match(formatGrep(hits), /^a2 · review · ok · 2m14s\n  5: for token reuse/);
});
