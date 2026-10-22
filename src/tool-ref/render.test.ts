import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { hideTrailer } from "./render.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
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
