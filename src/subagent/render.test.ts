import { test } from "node:test";
import assert from "node:assert/strict";
import { fgToBg, headerLine, resultRenderer, resultRowLines, warningBg } from "./render.ts";
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
  assert.deepEqual(resultRowLines(result(), th).slice(1), ["first line <dim>· /agent a3 for details"]);
  const render = resultRenderer(() => {});
  const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t, getFgAnsi: () => "" } as any;
  const message = { role: "custom", customType: "subagent-result", content: "x", display: true, details: result(), timestamp: 0 } as any;
  const collapsed = render(message, { expanded: false, outputPad: 0 } as any, plain)!.render(80);
  const expanded = render(message, { expanded: true, outputPad: 0 } as any, plain)!.render(80);
  assert.deepEqual(expanded, collapsed);
  assert.ok(!collapsed.join("\n").includes("second line"));
});

test("fgToBg / warningBg: the warning foreground as background, on every line of the block", () => {
  assert.equal(fgToBg("\x1b[38;5;3m"), "\x1b[48;5;3m");
  assert.equal(fgToBg("\x1b[38;2;10;20;30m"), "\x1b[48;2;10;20;30m");
  assert.equal(fgToBg("\x1b[2;38;2;1;2;3m"), "\x1b[48;2;1;2;3m");
  assert.equal(fgToBg("\x1b[33m"), "\x1b[43m");
  assert.equal(fgToBg("\x1b[93m"), "\x1b[103m");
  assert.equal(fgToBg(""), undefined);
  const bg = warningBg({ getFgAnsi: () => "\x1b[38;5;3m" } as any);
  assert.equal(bg("a\x1b[0mb"), "\x1b[48;5;3ma\x1b[0m\x1b[48;5;3mb\x1b[49m");
  const row = resultRenderer(() => {})(
    { role: "custom", customType: "subagent-result", content: "x", display: true, details: result(), timestamp: 0 } as any,
    { expanded: false, outputPad: 1 } as any,
    { fg: (_c: string, t: string) => t, bold: (t: string) => t, getFgAnsi: () => "\x1b[38;5;3m" } as any,
  )!;
  const lines = row.render(60);
  assert.equal(lines.length, 4, "padding line, header, summary, padding line");
  assert.ok(lines.every((l) => l.startsWith("\x1b[48;5;3m")));
});

test("a left click on a row opens that result", () => {
  const opened: string[] = [];
  const row = resultRenderer((id) => opened.push(id))(
    { role: "custom", customType: "subagent-result", content: "x", display: true, details: result(), timestamp: 0 } as any,
    { expanded: false, outputPad: 0 } as any,
    { fg: (_c: string, t: string) => t, bold: (t: string) => t, getFgAnsi: () => "" } as any,
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
