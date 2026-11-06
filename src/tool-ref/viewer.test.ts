import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { RefSection } from "./format.ts";
import { RefViewer } from "./viewer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const tui = { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI;

/** A viewer over `handles` whose pages are plain text; `built` lists the handles built, in order. */
function viewer(handles: number[], options: { start?: number } = {}) {
  const built: number[] = [];
  const build = (n: number): RefSection => (built.push(n), { handle: n, header: `#${n} bash ok`, text: `page ${n}` });
  const v = new RefViewer(tui, theme, "/ref", handles, build, undefined, () => {}, options);
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

test("shift+←/→ jump to the first/last page; the pages between are not built", () => {
  const { v, built, title } = viewer([1, 2, 3, 4, 5], { start: 4 });
  assert.match(v.render(200).at(-2)!, /⇧←→ first\/last/);
  v.handleInput("\x1b[1;2D"); // shift+left
  assert.match(title(), /‹ 1\/5 › #1/);
  v.handleInput("\x1b[1;2D"); // already first
  v.handleInput("\x1b[1;2C"); // shift+right
  assert.match(title(), /‹ 5\/5 › #5/);
  assert.deepEqual(built, [5, 1]);
  // One page: no pager, no jump hint.
  assert.doesNotMatch(viewer([7]).v.render(200).join("\n"), /first\/last|‹/);
});

test("start page: opens there (clamped), ← goes to older pages", () => {
  const { v, built, title } = viewer([3, 5, 9], { start: 2 });
  assert.match(title(), /‹ 3\/3 › #9 bash ok/);
  v.handleInput("\x1b[D"); // left
  assert.match(title(), /‹ 2\/3 › #5 bash ok/);
  assert.deepEqual(built, [9, 5]);
  assert.match(viewer([3, 5], { start: 7 }).title(), /‹ 2\/2 › #5/);
  assert.match(viewer([3, 5], { start: -1 }).title(), /‹ 1\/2 › #3/);
});

/** One page with a resolved call, for the copy tests. */
function copyViewer(copy: (text: string) => Promise<void>) {
  const ref = {
    handle: 4, toolName: "bash", toolCallId: "t", isError: false, ambiguous: false, excluded: false,
    input: { command: "echo hi\necho there" }, content: [{ type: "text", text: "hi\nthere" }], output: "hi\nthere",
  };
  const build = (n: number): RefSection => ({ handle: n, ref: ref as unknown as RefSection["ref"], header: "#4 bash ok", text: "x" });
  const v = new RefViewer(tui, theme, "/ref", [4, 5], build, undefined, () => {}, { copy });
  const footer = () => v.render(200).at(-2)!;
  return { v, footer };
}

const settle = () => new Promise((r) => setImmediate(r));

test("c then o / c copies the output, c then i the input; the footer reports it", async () => {
  const copied: string[] = [];
  const { v, footer } = copyViewer(async (t) => void copied.push(t));
  assert.match(footer(), /c copy/);
  v.handleInput("c");
  assert.match(footer(), /copy: o\/c output · i input/);
  v.handleInput("o");
  await settle();
  assert.match(footer(), /copied output of #4 \(2 lines/);
  v.handleInput("c");
  v.handleInput("i");
  await settle();
  v.handleInput("c");
  v.handleInput("c");
  await settle();
  assert.deepEqual(copied, ["hi\nthere", "echo hi\necho there", "hi\nthere"]);
  // Any other key cancels, and is not acted on (no page change).
  v.handleInput("c");
  v.handleInput("l");
  assert.match(v.render(200)[1]!, /‹ 1\/2/);
  assert.equal(copied.length, 3);
});

test("a failed copy is reported; the next key clears it", async () => {
  const { v, footer } = copyViewer(async () => {
    throw new Error("no clipboard");
  });
  v.handleInput("c");
  v.handleInput("i");
  await settle();
  assert.match(footer(), /copy failed: no clipboard/);
  v.handleInput("j");
  assert.match(footer(), /c copy/);
});

test("a page without a call has nothing to copy", () => {
  let calls = 0;
  const v = new RefViewer(tui, theme, "/ref", [9], (n) => ({ handle: n, text: "no such handle" }), undefined, () => {}, {
    copy: async () => void calls++,
  });
  v.handleInput("c");
  v.handleInput("o");
  assert.match(v.render(200).at(-2)!, /nothing to copy/);
  assert.equal(calls, 0);
});
