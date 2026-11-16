import { test } from "node:test";
import assert from "node:assert/strict";
import { headerLine, resultRenderer, resultRowLines } from "./render.ts";
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

test("header: warm label, ID, scenario, coloured status, duration", () => {
  assert.equal(headerLine(result(), th), "<warning>[subagent] a3 <muted>· review <muted>· <success>ok <muted>· <dim>2m14s");
  assert.match(headerLine(result({ status: "error" }), th), /<error>error/);
  assert.match(headerLine(result({ status: "killed", reason: "user" }), th), /<error>killed by user/);
  assert.match(headerLine(result({ status: "aborted", reason: "leader_exit" }), th), /<error>aborted /);
});

test("a row is the header and the summary's first line with where to see the rest; it never expands", () => {
  assert.deepEqual(resultRowLines(result(), th).slice(1), ["first line <dim>· /agent a3 for details"]);
  const render = resultRenderer(() => {});
  const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
  const message = { role: "custom", customType: "subagent-result", content: "x", display: true, details: result(), timestamp: 0 } as any;
  const collapsed = render(message, { expanded: false, outputPad: 0 } as any, plain)!.render(80);
  const expanded = render(message, { expanded: true, outputPad: 0 } as any, plain)!.render(80);
  assert.deepEqual(expanded, collapsed);
  assert.ok(!collapsed.join("\n").includes("second line"));
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
  assert.deepEqual(row.handleMouse(event("click", "left")), { handled: true, render: false });
  assert.deepEqual(opened, ["a3"]);
});
