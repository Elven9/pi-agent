import { test } from "node:test";
import assert from "node:assert/strict";
import { headerLine, resultRowLines } from "./render.ts";
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

test("header: label, ID, scenario, coloured status, duration", () => {
  assert.equal(headerLine(result(), th), "<accent>[subagent] a3 <muted>· review <muted>· <success>ok <muted>· <dim>2m14s");
  assert.match(headerLine(result({ status: "error" }), th), /<warning>error/);
  assert.match(headerLine(result({ status: "killed", reason: "user" }), th), /<error>killed by user/);
  assert.match(headerLine(result({ status: "aborted", reason: "leader_exit" }), th), /<error>aborted /);
});

test("collapsed: header and the summary's first line with an expand hint; expanded: the whole result", () => {
  const collapsed = resultRowLines(result(), false, th, "ctrl+o to expand");
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[1], "first line <dim>(ctrl+o to expand)");
  assert.equal(resultRowLines(result({ summary: "one" }), false, th, "x")[1], "one");
  const expanded = resultRowLines(result({ detail: { n: 1 } }), true, th);
  assert.ok(expanded.some((l) => l.includes("second line")));
  assert.ok(expanded.some((l) => l.includes('"n": 1')));
});
