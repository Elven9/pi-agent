import { test } from "node:test";
import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import { type AgentPage, AgentViewer, headingRow } from "./viewer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function viewer(ids: number[], pages: Map<number, AgentPage>, start = 0) {
  let renders = 0;
  const tui = { terminal: { rows: 30 }, requestRender: () => void renders++ } as unknown as TUI;
  const killed: number[] = [];
  let closed = false;
  const v = new AgentViewer(
    tui,
    theme,
    "/agent",
    ids,
    (id) => pages.get(id)!,
    async (id) => {
      killed.push(id);
      pages.set(id, { title: `a${id} · killed by user`, lines: ["killed by user"], live: false });
      return `a${id}: killed by user.`;
    },
    () => void (closed = true),
    { start },
  );
  return { v, killed, closed: () => closed, title: () => v.render(70)[1]!, footer: () => v.render(70).at(-2)!, renders: () => renders };
}

test("pages: opens at start, ←/→ between agents, title shows the page", () => {
  const pages = new Map<number, AgentPage>([
    [1, { title: "a1 · review · ok", lines: ["one"], live: false }],
    [2, { title: "a2 · review · busy", lines: ["two"], live: true }],
  ]);
  const { v, title, closed } = viewer([1, 2], pages, 1);
  assert.match(title(), /\/agent · ‹ 2\/2 › · a2 · review · busy/);
  v.handleInput("h");
  assert.match(title(), /‹ 1\/2 › · a1/);
  v.handleInput("q");
  assert.equal(closed(), true);
  v.dispose();
});

test("x on a live page asks, y kills; n or a finished page does nothing", async () => {
  const pages = new Map<number, AgentPage>([
    [1, { title: "a1 · done", lines: ["x"], live: false }],
    [2, { title: "a2 · busy", lines: ["progress"], live: true }],
  ]);
  const { v, killed, footer, title } = viewer([1, 2], pages, 0);
  v.handleInput("x");
  assert.doesNotMatch(footer(), /kill a1\?/, "finished: no kill");
  v.handleInput("l");
  assert.match(footer(), /x kill/);
  v.handleInput("x");
  assert.match(footer(), /kill a2\? y\/n/);
  v.handleInput("n");
  assert.deepEqual(killed, []);
  v.handleInput("x");
  v.handleInput("y");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(killed, [2]);
  assert.match(footer(), /a2: killed by user\./);
  assert.match(title(), /a2 · killed by user/, "the page is rebuilt as finished");
  v.dispose();
});

test("section headings: a bold accent label and a dim rule; other lines as written", () => {
  const styled = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => `*${text}*` };
  assert.equal(headingRow("summary:", 12, theme), "Summary ────");
  // The fake markup counts toward the width, so only the label is checked here.
  assert.match(headingRow("detail (x/v1):", 30, styled), /^\*<accent>Detail \(x\/v1\)<\/>\* /);
  const pages = new Map<number, AgentPage>([[1, { title: "a1", lines: ["meta", "", "task:", "summary:"], headings: [2], live: false }]]);
  const rows = viewer([1], pages).v.render(40);
  assert.ok(rows.some((r) => r.includes("Task ──")), rows.join("\n"));
  assert.ok(rows.some((r) => r.includes("summary:")), "a non-heading line that looks like one stays as written");
});
