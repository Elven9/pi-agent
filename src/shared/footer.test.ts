import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { decorate, footerSessionStart, parts, setFooterPart } from "./footer.ts";

const theme = { fg: (_c: string, t: string) => t };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("decorate: left before the cwd, right at the end of the first line; other lines untouched", () => {
  const out = decorate(["~/w (main) • s", "stats"], { left: ["[a]"], right: ["🤖 1 busy"] }, theme, 40);
  assert.equal(out[1], "stats");
  assert.ok(out[0]!.startsWith("[a] ~/w (main) • s "));
  assert.ok(out[0]!.endsWith("🤖 1 busy"));
  assert.equal(visibleWidth(out[0]!), 40);
});

test("decorate: a narrow line cuts the cwd side first, then drops the right part", () => {
  const cut = decorate(["~/a/very/long/path/to/somewhere"], { left: [], right: ["🤖 2 busy"] }, theme, 30);
  assert.equal(visibleWidth(cut[0]!), 30);
  assert.ok(strip(cut[0]!).endsWith("🤖 2 busy"));
  assert.match(strip(cut[0]!), /\.\.\. +🤖/);
  const tiny = decorate(["~/a/very/long/path"], { left: [], right: ["🤖 2 busy"] }, theme, 15);
  assert.ok(!tiny[0]!.includes("🤖"));
  assert.deepEqual(decorate(["x"], { left: [], right: [] }, theme, 10), ["x"]);
});

function fakeCtx(mode = "tui") {
  const calls: Array<unknown> = [];
  const ui = { setFooter: (f: unknown) => void calls.push(f) };
  const ctx = { mode, ui } as unknown as ExtensionContext;
  return { ctx, calls };
}
const pi = { getSettings: () => ({}), getThinkingLevel: () => "off" } as unknown as ExtensionAPI;

test("setFooterPart: one footer for several parts; pi's own footer back when the last part goes", () => {
  footerSessionStart();
  const { ctx, calls } = fakeCtx();
  setFooterPart(pi, ctx, "tags", "left", "[a]");
  setFooterPart(pi, ctx, "subagents", "right", "🤖 1 busy");
  setFooterPart(pi, ctx, "subagents", "right", "🤖 2 busy");
  assert.equal(calls.length, 1, "installed once; it reads the parts on every render");
  assert.deepEqual(parts(), { left: ["[a]"], right: ["🤖 2 busy"] });
  setFooterPart(pi, ctx, "tags", "left", undefined);
  assert.equal(calls.length, 1);
  setFooterPart(pi, ctx, "subagents", "right", undefined);
  assert.deepEqual(calls.slice(1), [undefined], "restored");
  // A new session installs again.
  setFooterPart(pi, ctx, "tags", "left", "[b]");
  footerSessionStart();
  setFooterPart(pi, ctx, "subagents", "right", "🤖 1 busy");
  assert.equal(calls.filter((c) => typeof c === "function").length, 3);
  setFooterPart(pi, ctx, "tags", "left", undefined);
  setFooterPart(pi, ctx, "subagents", "right", undefined);
});

test("setFooterPart: nothing outside the TUI", () => {
  const { ctx, calls } = fakeCtx("rpc");
  setFooterPart(pi, ctx, "subagents", "right", "🤖 1 busy");
  assert.equal(calls.length, 0);
  assert.deepEqual(parts().right, []);
});
