import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { hideTrailer } from "./render.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text } as unknown as Theme;
const options = { expanded: false, isPartial: false };
const context = {} as any;
const saved = {
  content: [{ type: "text" as const, text: "out" }, { type: "text" as const, text: "[tool-ref #3]" }],
  details: { d: 1 },
};
const rendered = (component: unknown) => (component as Text).render(80).map((l) => l.trimEnd());

test("wraps the tool's renderResult: it gets the content without the trailer", () => {
  let seen: unknown;
  const base: ToolRenderers = {
    renderShell: "self",
    renderCall: () => new Text("call", 0, 0),
    renderResult: (result) => ((seen = result), new Text("r", 0, 0)),
  };
  const set = hideTrailer("bash", () => base)!;
  assert.equal(set.renderShell, "self");
  assert.equal(set.renderCall, base.renderCall);
  set.renderResult!(saved, options, theme, context);
  assert.deepEqual(seen, { content: [{ type: "text", text: "out" }], details: { d: 1 } });
  // The saved result itself is untouched.
  assert.equal(saved.content.length, 2);
});

test("custom tools without renderResult get a text fallback without the trailer", () => {
  const set = hideTrailer("mcp_tool", () => ({}))!;
  assert.deepEqual(rendered(set.renderResult!(saved, options, theme, context)), ["out"]);
  const long = { content: [{ type: "text" as const, text: Array.from({ length: 15 }, (_, i) => `l${i}`).join("\n") }, saved.content[1]], details: {} };
  const lines = rendered(set.renderResult!(long, options, theme, context));
  assert.equal(lines.length, 11);
  assert.match(lines[10], /\.\.\. \(5 more lines, to expand\)/);
  assert.equal(rendered(set.renderResult!(long, { ...options, expanded: true }, theme, context)).length, 15);
});

test("built-in tools without renderResult (HTML export) and unknown tools are left to pi", () => {
  const bare = {};
  assert.equal(hideTrailer("bash", () => bare), bare);
  assert.equal(hideTrailer("not_connected", () => undefined), undefined);
});

// --- Compact codemode rows ---

import { formatDuration, RowStore, scriptIntent, toolRefRenderer } from "./render.ts";

const SCRIPT = '// @options: {"timeout_ms": 1000}\n// intent: list files and read package.json\nreturn 1;';
const lines = (component: unknown, width = 80) => (component as Text).render(width).map((l) => l.trimEnd());
const rowContext = (over: Record<string, unknown> = {}) =>
  ({ toolCallId: "c1", args: { code: SCRIPT }, invalidate: () => {}, state: {}, isError: false, durationMs: undefined, ...over }) as any;
const codemodeBase: ToolRenderers = {
  renderCall: () => new Text("pi call", 0, 0),
  renderResult: (result) => new Text(`pi result: ${(result.content[0] as { text: string }).text}`, 0, 0),
};

test("scriptIntent: the first line, or right after // @options:", () => {
  assert.equal(scriptIntent(SCRIPT), "list files and read package.json");
  assert.equal(scriptIntent("//intent:  x y \nreturn 1"), "x y");
  assert.equal(scriptIntent("return 1;\n// intent: too late"), undefined);
  assert.equal(scriptIntent(""), undefined);
});

test("formatDuration", () => {
  assert.equal(formatDuration(77), "77ms");
  assert.equal(formatDuration(1234), "1.2s");
  assert.equal(formatDuration(125_000), "2m 05s");
});

test("codemode call: intent line, then an empty line and the metadata line once there is metadata", () => {
  const rows = new RowStore();
  const set = toolRefRenderer(rows)("codemode", () => codemodeBase)!;
  // Running: no handle or duration yet, so no metadata line.
  assert.deepEqual(lines(set.renderCall!({ code: SCRIPT }, theme, rowContext())), ["[codemode] list files and read package.json"]);
  rows.set("c1", { handle: 12 });
  assert.deepEqual(lines(set.renderCall!({ code: SCRIPT }, theme, rowContext({ durationMs: 77 }))), [
    "[codemode] list files and read package.json",
    "",
    "#12 · 77ms",
  ]);
  // Duration from the store (resumed session, HTML export) when the context has none.
  rows.set("c1", { durationMs: 1500 });
  assert.deepEqual(lines(set.renderCall!({ code: SCRIPT }, theme, rowContext())).at(-1), "#12 · 1.5s");
  // No intent: the script's first line; errors are marked in the metadata.
  assert.deepEqual(lines(set.renderCall!({ code: "const a = 1;\nreturn a;" }, theme, rowContext({ toolCallId: "c2", isError: true }))), [
    "[codemode] const a = 1;…",
    "",
    "failed",
  ]);
  // The intent line never wraps: cut to the width.
  assert.equal(lines(set.renderCall!({ code: `// intent: ${"x".repeat(200)}` }, theme, rowContext({ toolCallId: "c3" })), 40).length, 1);
});

test("codemode result: empty collapsed; expanded shows the script, then pi's view without the trailer", () => {
  const rows = new RowStore();
  const set = toolRefRenderer(rows)("codemode", () => codemodeBase)!;
  assert.deepEqual(lines(set.renderResult!(saved, options, theme, rowContext())), []);
  const expanded = lines(set.renderResult!(saved, { ...options, expanded: true }, theme, rowContext()));
  assert.deepEqual(expanded.filter((l) => l), [...SCRIPT.split("\n"), "pi result: out"]);
  // The saved trailer filled the handle.
  assert.equal(rows.get("c1").handle, 3);
});

test("codemode row is redrawn when its handle arrives after it was drawn (live rows)", async () => {
  const rows = new RowStore();
  const set = toolRefRenderer(rows)("codemode", () => codemodeBase)!;
  let redraws = 0;
  set.renderCall!({ code: SCRIPT }, theme, rowContext({ invalidate: () => redraws++ }));
  rows.set("c1", { handle: 5 });
  rows.set("c1", { handle: 5 }); // unchanged: no second redraw
  await Promise.resolve();
  assert.equal(redraws, 1);
});

test("other tools keep their renderers; codemode unknown to pi stays unknown", () => {
  const rows = new RowStore();
  const base: ToolRenderers = { renderCall: () => new Text("call", 0, 0) };
  assert.equal(toolRefRenderer(rows)("bash", () => base)!.renderCall, base.renderCall);
  assert.equal(toolRefRenderer(rows)("codemode", () => undefined), undefined);
});
