import { test } from "node:test";
import assert from "node:assert/strict";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextView } from "./format.ts";
import { highlightPrompt, type Styler } from "./highlight.ts";
import { ContextViewer, contextPanel } from "./viewer.ts";

/** Marks styles as text: [token:text] and *bold*. */
const s: Styler = { fg: (token, text) => `[${token}:${text}]`, bold: (text) => `*${text}*` };
const code = (body: string, lang: string | undefined) => body.split("\n").map((l) => `{${lang ?? "-"}:${l}}`);

test("highlightPrompt: tags and attributes, headings, bullets, inline code, bold", () => {
  const lines = highlightPrompt(
    ['<skill name="golang">', "## Rules", "- use `<b>` **now**", "</skill>", "plain"].join("\n"),
    s,
    code,
  );
  assert.deepEqual(lines, [
    '[syntaxPunctuation:<][syntaxKeyword:skill] [syntaxVariable:name]=[syntaxString:"golang"][syntaxPunctuation:>]',
    "*[mdHeading:## Rules]*",
    "[mdListBullet:-] use [mdCode:`<b>`] ***now***",
    "[syntaxPunctuation:</][syntaxKeyword:skill][syntaxPunctuation:>]",
    "plain",
  ]);
});

test("highlightPrompt: fenced blocks go to the code highlighter; unclosed fences stay prose", () => {
  assert.deepEqual(highlightPrompt("a\n```ts\nconst x = 1;\nx;\n```\nb", s, code), [
    "a",
    "[mdCodeBlockBorder:```ts]",
    "{ts:const x = 1;}",
    "{ts:x;}",
    "[mdCodeBlockBorder:```]",
    "b",
  ]);
  assert.deepEqual(highlightPrompt("```\nx", s, code), ["```", "x"]);
  // A highlighter that changes the line count is ignored (lines must stay aligned).
  assert.deepEqual(highlightPrompt("```sh\nls\n```", s, () => []), ["[mdCodeBlockBorder:```sh]", "ls", "[mdCodeBlockBorder:```]"]);
});

const view = (over: Partial<ContextView> = {}): ContextView => ({
  scenario: "code-writer",
  tools: [{ name: "read", builtin: true }],
  systemPrompt: "PRE\n\n<p>x</p>",
  built: true,
  blockB: "<p>x</p>",
  sections: [
    { name: "preamble", text: "PRE" },
    { name: "project", text: "<p>x</p>" },
  ],
  ...over,
});

test("contextPanel: setup lines, then one rule per section (block B marked) with its text", () => {
  const { lines, sections } = contextPanel(view(), s, code);
  assert.match(lines[0]!, /^\[muted:scenario:\] code-writer$/);
  assert.deepEqual(
    sections.map((x) => x.title),
    ["preamble", "project · block B (project)"],
  );
  assert.match(lines[sections[0]!.line]!, /\[accent:preamble\]\[dim: ~1 tokens \]/);
  assert.equal(lines[sections[0]!.line + 1], "PRE");
  assert.match(lines[sections[1]!.line + 1]!, /\[syntaxKeyword:p\]/);
});

test("contextPanel in a resumed session: block B from the announced section names", () => {
  const v = view({ blockB: "", blockBSections: ["project"] });
  const { lines, sections } = contextPanel(v, s, code);
  assert.deepEqual(sections.map((x) => x.title), ["preamble", "project · block B (project)"]);
  assert.match(lines.find((l) => l.includes("system prompt:"))!, /\(block A ~1, block B ~2\)/);
});

test("contextPanel before the first prompt: the base prompt as one part, with the note", () => {
  const { lines, sections } = contextPanel(view({ built: false, sections: undefined, systemPrompt: "BASE" }), s, code);
  assert.ok(lines.some((l) => l.startsWith("[warning:Not built yet")));
  assert.deepEqual(sections.map((x) => x.title), ["system prompt (base)"]);
  assert.equal(lines.at(-1), "BASE");
});

test("ContextViewer: fits the width, scrolls, jumps between sections, closes on q", () => {
  let renders = 0;
  let closed = false;
  const tui = { terminal: { rows: 20 }, requestRender: () => void renders++ } as unknown as TUI;
  const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const v = view({
    sections: [
      { name: "preamble", text: long },
      { name: "skills", text: long },
    ],
  });
  const plain: Styler = { fg: (_t, text) => text, bold: (text) => text };
  const viewer = new ContextViewer(tui, plain, v, () => void (closed = true), code);
  const first = viewer.render(50);
  assert.equal(first.length, 16); // 80% of 20 rows
  assert.ok(first.every((l) => visibleWidth(l) === 50));
  assert.match(first[1]!, /\/context  1-12\//);

  viewer.handleInput("l"); // next section: preamble
  assert.match(viewer.render(50)[1]!, /preamble \(1\/2\)/);
  viewer.handleInput("l"); // skills
  assert.match(viewer.render(50)[1]!, /skills \(2\/2\)/);
  assert.match(viewer.render(50)[2]!, /──── skills/);
  viewer.handleInput("h"); // back to preamble
  assert.match(viewer.render(50)[1]!, /preamble \(1\/2\)/);
  viewer.handleInput("j");
  assert.ok(renders >= 4);
  viewer.handleInput("q");
  assert.equal(closed, true);
});
