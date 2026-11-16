import { test } from "node:test";
import assert from "node:assert/strict";
import { capText, headerLine, resultRenderer, resultRowLines, TASK_CHARS } from "./render.ts";
import type { ResultBody, ResultDetails } from "./protocol.ts";

const th = { fg: (color: string, text: string) => `<${color}>${text}`, bold: (text: string) => text };

const result = (body: Partial<ResultBody> = {}): ResultDetails => ({
  agentId: "a3",
  resultId: "a3",
  scenario: "review",
  kind: "task",
  task: "check auth",
  startedAt: 0,
  endedAt: 134_000,
  envelope: { v: 1, id: "m", from: "agent:a3", to: "leader", kind: "result", ts: 0, body: { status: "ok", summary: "first line\nsecond line", ...body } },
});

test("header: label like codemode's (accent), ID, scenario, coloured status, duration", () => {
  assert.equal(headerLine(result(), th), "<accent>[subagent] a3 <muted>· review <muted>· <success>ok <muted>· <dim>2m14s");
  assert.match(headerLine(result({ status: "error" }), th), /<error>error/);
  assert.match(headerLine(result({ status: "killed", reason: "user" }), th), /<error>killed by user/);
  assert.match(headerLine(result({ status: "aborted", reason: "leader_exit" }), th), /<error>aborted /);
});

test("a row is the header and the summary's first line with where to see the rest; it never expands", () => {
  assert.deepEqual(resultRowLines(result(), th).slice(1), ["check auth", "<dim>/agent a3 for details"]);
  const render = resultRenderer(() => {});
  const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
  const message = { role: "custom", customType: "subagent-result", content: "x", display: true, details: result(), timestamp: 0 } as any;
  const collapsed = render(message, { expanded: false, outputPad: 0 } as any, plain)!.render(80);
  const expanded = render(message, { expanded: true, outputPad: 0 } as any, plain)!.render(80);
  assert.deepEqual(expanded, collapsed);
  assert.ok(!collapsed.join("\n").includes("first line"), "the summary is not in the row");
});

test("capText: one line, cut with ... when longer than the cap", () => {
  assert.equal(capText("fix\n  the   bug", 50), "fix the bug");
  assert.equal(capText("x".repeat(10), 10), "x".repeat(10));
  assert.equal(capText("abcdefghijk", 10), "abcdefg...");
  const long = resultRowLines({ ...result(), task: "word ".repeat(100) }, th)[1]!;
  assert.ok(long.endsWith("..."));
  assert.ok(long.length <= TASK_CHARS);
});

test("the row sits between two amber rules; the label stays accent (pink)", () => {
  const th2 = { fg: (color: string, text: string) => `<${color}>${text}`, bold: (text: string) => text } as any;
  const row = resultRenderer(() => {})(
    { role: "custom", customType: "subagent-result", content: "x", display: true, details: result(), timestamp: 0 } as any,
    { expanded: false, outputPad: 1 } as any,
    th2,
  )!;
  const lines = row.render(120);
  assert.equal(lines.length, 5, "rule, header, summary, hint, rule");
  assert.equal(lines[0], "<warning>" + "─".repeat(120));
  assert.equal(lines[4], lines[0]);
  assert.match(lines[3]!, /^ <dim>\/agent a3 for details/);
  assert.match(lines[1]!, /^ <accent>\[subagent\]/);
});

test("a left click on a row opens that result", () => {
  const opened: string[] = [];
  const row = resultRenderer((id) => opened.push(id))(
    { role: "custom", customType: "subagent-result", content: "x", display: true, details: result(), timestamp: 0 } as any,
    { expanded: false, outputPad: 0 } as any,
    { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
  ) as any;
  const event = (type: string, button: string) => ({ type, button, x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 2, shift: false, alt: false, ctrl: false });
  assert.equal(row.handleMouse(event("press", "left")), undefined);
  assert.equal(row.handleMouse(event("click", "right")), undefined);
  const r = row.handleMouse(event("click", "left"));
  assert.equal(r.handled, true);
  assert.equal(r.render, false);
  assert.equal(r.target.component, row);
  assert.deepEqual(opened, ["a3"]);
});
