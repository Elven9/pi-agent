import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { RefSection } from "./format.ts";
import { RefViewer } from "./viewer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const tui = { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI;

/** A viewer over `handles` whose pages are plain text; `built` lists the handles built, in order. */
function viewer(handles: number[]) {
  const built: number[] = [];
  const build = (n: number): RefSection => (built.push(n), { handle: n, header: `#${n} bash ok`, text: `page ${n}` });
  const v = new RefViewer(tui, theme, "/ref", handles, build, undefined, () => {});
  const title = () => v.render(60)[1]!;
  return { v, built, title };
}

test("builds a page only when it is first shown, once", () => {
  const { v, built, title } = viewer([3, 5, 9]);
  assert.deepEqual(built, []);
  assert.match(title(), /‹ 1\/3 › #3 bash ok/);
  assert.deepEqual(built, [3]);
  // Paged past without a render: #5 is never built.
  v.handleInput("l");
  v.handleInput("l");
  v.handleInput("l"); // past the end: stays on the last page
  assert.match(title(), /‹ 3\/3 › #9 bash ok/);
  assert.deepEqual(built, [3, 9]);
  v.handleInput("h");
  assert.match(title(), /‹ 2\/3 › #5 bash ok/);
  v.handleInput("h");
  title();
  v.handleInput("l");
  title();
  assert.deepEqual(built, [3, 9, 5]);
});
