import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activationHint, { activationRows, boxLines, MARGIN, renderRows, WIDGET_KEY } from "./index.ts";
import { PROJECT_CHANNEL, SCENARIO_CHANNEL, SKILLS_CHANNEL } from "../shared/protocol.ts";

/** No colours: widths are exact. */
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
/** Marks colours as tags, so the tests can see them. */
const tagged = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `*${text}*` };

function setup(mode = "tui", width = 100) {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  /** setWidget calls: the rendered lines, or undefined for a clear. */
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  const other: string[] = [];
  const pi = {
    events: {
      on: (channel: string, l: (data: unknown) => void) => void listeners.set(channel, [...(listeners.get(channel) ?? []), l]),
    },
    on: (event: string, h: (event: unknown, ctx: unknown) => unknown) => void handlers.set(event, [...(handlers.get(event) ?? []), h]),
    // Must never be used: nothing goes into the session or to the model.
    appendEntry: () => void other.push("appendEntry"),
    sendMessage: () => void other.push("sendMessage"),
  } as unknown as ExtensionAPI;
  activationHint(pi);
  const ctx = {
    mode,
    ui: {
      setWidget: (key: string, factory: ((tui: unknown, t: typeof plain) => { render(w: number): string[] }) | undefined) =>
        void widgets.push({ key, lines: factory?.({}, plain).render(width).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")) }),
      notify: () => void other.push("notify"),
    },
  };
  const fire = (event: string) => handlers.get(event)?.forEach((h) => h({ type: event }, ctx));
  return {
    widgets,
    other,
    emit: (channel: string, data: unknown) => listeners.get(channel)?.forEach((l) => l(data)),
    start: () => fire("session_start"),
    prompt: () => fire("agent_start"),
  };
}

test("scenario, project and the final skills in a bordered box; cleared on the first prompt only", () => {
  const s = setup("tui", 72);
  s.emit(SCENARIO_CHANNEL, { name: "code-writer" });
  s.emit(PROJECT_CHANNEL, { project: { name: "demo", dir: "/p/demo" }, block: "" });
  s.emit(SKILLS_CHANNEL, { skills: ["golang", "agent-browser"], missing: [], descriptions: { golang: "Go conventions.", "agent-browser": "Browser\nautomation CLI for AI agents, with a long description." } });
  s.start();
  assert.equal(s.widgets.length, 1);
  assert.equal(s.widgets[0].key, WIDGET_KEY);
  assert.deepEqual(s.widgets[0].lines, [
    "",
    "  ╭─ pi-agent ───────────────────────────────────────────────────────╮",
    "  │ Scenario  code-writer · its system prompt, tools and skills are… │",
    "  │ Project   demo · /p/demo · /project shows its context            │",
    "  │ Skills    2 active                                               │",
    "  │           • golang  Go conventions.                              │",
    "  │           • agent-browser  Browser automation CLI for AI agents… │",
    "  ╰──────────────────────────────────────────────────────────────────╯",
    "",
  ]);
  s.prompt();
  s.prompt();
  assert.deepEqual(s.widgets.slice(1), [{ key: WIDGET_KEY, lines: undefined }]);
  assert.deepEqual(s.other, []);
});

test("neither active: only the skills; the last announcement wins", () => {
  const s = setup();
  s.emit(SKILLS_CHANNEL, { skills: ["a"], missing: [] });
  s.emit(SKILLS_CHANNEL, { skills: ["golang"], missing: [] });
  s.emit(PROJECT_CHANNEL, { block: "" });
  s.start();
  const body = s.widgets[0].lines!.filter((l) => l.includes("│")).map((l) => l.replace(/^ *│ | *│$/g, ""));
  assert.deepEqual(body, ["Skills  1 active", "        • golang"]);
});

test("nothing announced: no widget (a stale one is cleared)", () => {
  const s = setup();
  s.emit(PROJECT_CHANNEL, { block: "" });
  s.start();
  assert.deepEqual(s.widgets, [{ key: WIDGET_KEY, lines: undefined }]);
  s.prompt();
  assert.equal(s.widgets.length, 1);
});

test("state is per session start", () => {
  const s = setup();
  s.emit(SCENARIO_CHANNEL, { name: "code-writer" });
  s.start();
  s.start();
  assert.notEqual(s.widgets[0].lines, undefined);
  assert.equal(s.widgets[1].lines, undefined);
});

test("not in TUI: no widget", () => {
  const s = setup("json");
  s.emit(SCENARIO_CHANNEL, { name: "code-writer" });
  s.start();
  s.prompt();
  assert.deepEqual(s.widgets, []);
});

test("renderRows: colours, aligned labels, skills as items, missing as a warning", () => {
  const rows = activationRows(undefined, { name: "p", dir: "r@v1" }, { skills: [], missing: ["nope"] });
  assert.deepEqual(renderRows(rows, tagged), [
    "<accent>*Project*</accent>  p <dim>· r@v1 · /project shows its context</dim>",
    "<accent>*Skills *</accent>  none",
    "<accent>*Missing*</accent>  <warning>nope</warning> <dim>· in project.yaml skills, not installed; skipped</dim>",
  ]);
  const items = activationRows(undefined, undefined, { skills: ["a", "b"], missing: [], descriptions: { a: "About a" } });
  assert.deepEqual(renderRows(items, tagged), [
    "<accent>*Skills*</accent>  2 active",
    "        <muted>•</muted> a  <dim>About a</dim>",
    "        <muted>•</muted> b",
  ]);
  assert.deepEqual(activationRows(), []);
});

test("boxLines: border in the border colour, margins; a narrow terminal gets no box", () => {
  const lines = boxLines(["hi"], 20, tagged);
  assert.equal(lines.length, 3 + 2 * MARGIN.y);
  assert.ok(lines[MARGIN.y].startsWith("  <border>╭─</border> <accent>*pi-agent*</accent> <border>"));
  assert.equal(lines[MARGIN.y + 1], "  <border>│</border> hi           <border>│</border>");
  assert.deepEqual(boxLines(["a long line here"], 12, plain).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")), ["a long line…"]);
});
