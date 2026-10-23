import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatGetMany,
  formatGrep,
  getStructured,
  grepRefs,
  grepStructured,
  inputLines,
  inputSummary,
  lookupSummary,
  refViewSections,
  scriptStart,
  STRUCTURED_MAX_CHARS,
} from "./format.ts";
import { indexBranch, isLookupOnly, lookupsOf, nestedToolsOf } from "./resolver.ts";
import { TestSession } from "./test-session.ts";

/**
 * Codemode: scripts get one handle, their nested tool-ref lookups show as provenance, and
 * tool_ref_get/grep return structured results (what scripts receive) next to the text.
 */

const SCRIPT = [
  '// @options: {"timeout_ms": 5000}',
  "",
  "const r = await tools.tool_ref_get({ refs: [1] });",
  'const g = await tools.bash({ command: "ls -al" });',
  "return r.results[0].output.length;",
].join("\n");

function session() {
  const s = new TestSession();
  s.user("go");
  s.calls(
    { id: "c1", tool: "bash", input: { command: "make" }, output: "cc a.c\nerror: missing header x.h\ncc b.c", handle: 1 },
    { id: "c2", tool: "submit_result", input: {}, output: "Result recorded.", handle: 2 },
  );
  s.calls({
    id: "c3",
    tool: "codemode",
    input: { code: SCRIPT },
    output: "Script completed\nOutput:\n37",
    handle: 3,
    nestedCalls: {
      calls: [
        { id: "c3/1", name: "tool_ref_get", arguments: { refs: [1] } },
        { id: "c3/2", name: "bash", arguments: { command: "ls -al" } },
        { id: "c3/3", name: "tool_ref_grep", arguments: { pattern: "error", refs: [1] } },
        { id: "c3/4", name: "tool_ref_get" }, // arguments omitted by pi (size limits)
      ],
    },
  });
  s.calls({ id: "c4", tool: "read", input: { path: "pic.png" }, content: [{ type: "text", text: "error in pic" }, { type: "image", data: "…" }], handle: 4 });
  return { s, index: indexBranch(s.entries, s.leafId, ["submit_result"]) };
}

test("codemode input summary: first code line, options line skipped", () => {
  assert.equal(scriptStart(SCRIPT), SCRIPT.split("\n").slice(2).join("\n"));
  assert.equal(scriptStart("return 1"), "return 1");
  assert.equal(inputSummary({ toolName: "codemode", input: { code: SCRIPT } }), "const r = await tools.tool_ref_get({ refs: [1] });…");
  // Input lines are the script lines, without a "code: " prefix, so in:N is the script line.
  assert.deepEqual(inputLines({ toolName: "codemode", input: { code: SCRIPT } }), SCRIPT.split("\n"));
});

test("lookups come from nestedCalls: tool-ref calls only, missing arguments kept as unknown", () => {
  const { index } = session();
  assert.deepEqual(index.byHandle.get(3)!.lookups, [
    { tool: "tool_ref_get", refs: [1] },
    { tool: "tool_ref_grep", refs: [1], pattern: "error" },
    { tool: "tool_ref_get" },
  ]);
  assert.deepEqual(index.byHandle.get(1)!.lookups, []);
  assert.deepEqual(lookupsOf(undefined), []);
  assert.deepEqual(lookupsOf({ calls: "nope" as never }), []);
});

test("provenance in get, grep and /ref: the script stays citable and says what it looked up", () => {
  const { index } = session();
  const line = "looked up: #1, grep /error/ in #1, get (arguments not recorded)";
  assert.equal(lookupSummary(index.byHandle.get(3)!), line);
  assert.equal(lookupSummary(index.byHandle.get(1)!), undefined);
  assert.equal(formatGetMany(index, [3]).text.split("\n")[1], line);
  assert.equal(formatGetMany(index, [3], { part: "input" }).text.split("\n")[1], line);
  const grep = formatGrep(grepRefs(index, { pattern: "ls -al" })).text;
  assert.match(grep, /^#3 codemode ok {3}const r = await .*… · looked up: #1, grep/);
  assert.match(grep, /in:4 +const g = await tools\.bash\(\{ command: "ls -al" \}\);/);
  const view = refViewSections(index, [3])[0]!;
  assert.ok(view.text.includes(`· ${line}\n`));
  // The script is a JavaScript code block in /ref.
  assert.deepEqual(view.blocks!.find((b) => b.kind === "code"), { kind: "code", lines: SCRIPT.split("\n"), lang: "javascript" });
});

test("structured get: whole output, no maxChars, input by part, timing, lookups, errors inline", () => {
  const { index } = session();
  const { results } = getStructured(index, [1, 3, 2, 99]);
  assert.deepEqual(results[0], {
    handle: 1,
    toolName: "bash",
    toolCallId: "c1",
    isError: false,
    input: null,
    output: "cc a.c\nerror: missing header x.h\ncc b.c",
    startedAt: index.byHandle.get(1)!.startedAt,
    endedAt: index.byHandle.get(1)!.endedAt,
  });
  assert.deepEqual((results[1] as { lookups?: unknown }).lookups, index.byHandle.get(3)!.lookups);
  assert.match((results[2] as { error: string }).error, /submit_result .*toolRef\.exclude/);
  assert.match((results[3] as { error: string }).error, /#99 is unknown/);

  const both = getStructured(index, [1], { part: "both" }).results[0] as { input: unknown; output: unknown };
  assert.deepEqual(both.input, { command: "make" });
  const input = getStructured(index, [1], { part: "input" }).results[0] as { input: unknown; output: unknown };
  assert.deepEqual([input.input, input.output], [{ command: "make" }, null]);
  // An image is a placeholder line.
  assert.equal((getStructured(index, [4]).results[0] as { output: string }).output, "error in pic\n[image]");
});

test("structured get: lines select a range (negative from the end); out of range is an inline error", () => {
  const { index } = session();
  assert.deepEqual(getStructured(index, [1], { lines: [2, 3] }).results[0], {
    ...(getStructured(index, [1]).results[0] as object),
    output: "error: missing header x.h\ncc b.c",
    lines: { from: 2, to: 3, total: 3 },
  });
  assert.equal((getStructured(index, [1], { lines: [-1, -1] }).results[0] as { output: string }).output, "cc b.c");
  assert.deepEqual(getStructured(index, [1], { lines: [5, 9] }).results[0], { handle: 1, error: "#1: output lines 5..9 are outside 1-3" });
});

test("structured get: output over the size cap is cut and marked", () => {
  const s = new TestSession();
  s.calls({ id: "big", tool: "bash", input: { command: "cat big" }, output: "x".repeat(STRUCTURED_MAX_CHARS + 10), handle: 1 });
  const item = getStructured(indexBranch(s.entries, s.leafId, []), [1]).results[0] as { output: string; truncated?: true };
  assert.equal(item.output.length, STRUCTURED_MAX_CHARS);
  assert.equal(item.truncated, true);
});

test("structured grep: whole lines, input and output named, images skipped, excluded skipped", () => {
  const { index } = session();
  const result = grepStructured(grepRefs(index, { pattern: "error" }));
  assert.deepEqual(result, {
    calls: [
      { handle: 4, toolName: "read", isError: false, matches: [{ where: "output", line: 1, text: "error in pic" }] },
      { handle: 1, toolName: "bash", isError: false, matches: [{ where: "output", line: 2, text: "error: missing header x.h" }] },
    ],
    omitted: 0,
    notes: [],
  });
  // Long lines are not cut (the text tool cuts at 200).
  const s = new TestSession();
  s.calls({ id: "w", tool: "bash", input: { command: "x" }, output: `${"a".repeat(500)} needle`, handle: 1 });
  const wide = grepStructured(grepRefs(indexBranch(s.entries, s.leafId, []), { pattern: "needle" }));
  assert.equal(wide.calls[0]!.matches[0]!.text.length, 507);
});

test("structured grep: per-call, total and size caps count omitted matches; notes and null handles", () => {
  const s = new TestSession();
  s.calls(
    { id: "a", tool: "bash", input: { command: "a" }, output: Array.from({ length: 60 }, (_, i) => `hit ${i}`).join("\n"), handle: 1 },
    { id: "b", tool: "bash", input: { command: "b" }, output: "hit b", handle: 2 },
    { id: "c", tool: "bash", input: { command: "c" }, output: "hit c" }, // no handle
  );
  const index = indexBranch(s.entries, s.leafId, []);
  const all = grepStructured(grepRefs(index, { pattern: "hit", in: "output" }));
  assert.deepEqual(all.calls.map((c) => [c.handle, c.matches.length]), [[null, 1], [2, 1], [1, 50]]);
  assert.equal(all.omitted, 10);
  const total = grepStructured(grepRefs(index, { pattern: "hit", in: "output" }), { total: 3 });
  assert.deepEqual(total.calls.map((c) => c.matches.length), [1, 1, 1]);
  assert.equal(total.omitted, 59);
  const chars = grepStructured(grepRefs(index, { pattern: "hit", in: "output" }), { maxChars: 10 });
  assert.deepEqual(chars.calls.map((c) => c.matches.map((m) => m.text)), [["hit c"], ["hit b"]]);
  assert.equal(chars.omitted, 60);
  const notes = grepStructured(grepRefs(index, { pattern: "hit", refs: [7] }));
  assert.deepEqual(notes, { calls: [], omitted: 0, notes: ["#7 is unknown (no tool result has this number)"] });
});

/** A script that ran bash, a script that only grepped (lookup-only), and a top-level bash call. */
function lookupSession() {
  const s = new TestSession();
  s.calls({
    id: "s1",
    tool: "codemode",
    input: { code: 'const r = await Promise.all([\n  tools.bash({ command: "pwd && ls" }),\n]);\nreturn r;' },
    output: "Script completed\nOutput:\n/work",
    handle: 1,
    nestedCalls: { calls: [{ name: "bash", arguments: { command: "pwd && ls" } }] },
  });
  s.calls({
    id: "s2",
    tool: "codemode",
    input: { code: 'return await tools.tool_ref_grep({ pattern: "pwd", tool: ["bash"] });' },
    output: 'Script completed\nOutput:\n{"calls":[{"handle":1,"text":"pwd && ls"}]}',
    handle: 2,
    nestedCalls: { calls: [{ name: "tool_ref_grep", arguments: { pattern: "pwd", tool: ["bash"] } }] },
  });
  s.calls({ id: "b1", tool: "bash", input: { command: "pwd" }, output: "/work", handle: 3 });
  return indexBranch(s.entries, s.leafId, []);
}

test("nested tools and lookup-only come from nestedCalls; an incomplete record is not lookup-only", () => {
  const index = lookupSession();
  assert.deepEqual(index.byHandle.get(1)!.nestedTools, ["bash"]);
  assert.deepEqual([1, 2, 3].map((n) => index.byHandle.get(n)!.lookupOnly), [false, true, false]);
  assert.deepEqual(nestedToolsOf({ calls: [{ name: "bash" }, { name: "read" }, { name: "bash" }, {}] }), ["bash", "read"]);
  assert.equal(isLookupOnly({ calls: [{ name: "tool_ref_get" }, { name: "tool_ref_grep" }], complete: true }), true);
  assert.equal(isLookupOnly({ calls: [{ name: "tool_ref_get" }], complete: false }), false);
  assert.equal(isLookupOnly({ calls: [], complete: true }), false);
  assert.equal(isLookupOnly(undefined), false);
});

test("grep: tool also matches scripts that called it; lookup-only scripts are skipped unless asked for", () => {
  const index = lookupSession();
  const handles = (o: Parameters<typeof grepRefs>[1]) => grepRefs(index, o).calls.map((c) => c.ref.handle);
  // tool: bash finds the top-level call and the script that ran bash, not the lookup script.
  assert.deepEqual(handles({ pattern: "pwd", tool: ["bash"], in: "input" }), [3, 1]);
  assert.deepEqual(handles({ pattern: "pwd" }), [3, 1]);
  assert.deepEqual(handles({ pattern: "pwd", tool: ["codemode"] }), [1]);
  // Asked for by number, the lookup script is searched; get shows it too.
  assert.deepEqual(handles({ pattern: "pwd", refs: [2] }), [2]);
  assert.equal(getStructured(index, [2]).results[0]!.handle, 2);
  // The script line, numbered as in the script.
  assert.match(
    formatGrep(grepRefs(index, { pattern: "pwd", tool: ["bash"], in: "input" })).text,
    /#1 codemode ok +const r = .*\n {2}in:2 +tools\.bash\(\{ command: "pwd && ls" \}\),/,
  );
});
