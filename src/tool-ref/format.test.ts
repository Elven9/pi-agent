import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePattern, formatGetMany, formatGrep, grepRefs, inputLines, inputSummary, type GrepOptions } from "./format.ts";
import { indexBranch } from "./resolver.ts";
import { TestSession } from "./test-session.ts";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

function session() {
  const s = new TestSession();
  s.user("go");
  s.calls(
    { id: "c1", tool: "bash", input: { command: "apfs-fuse -l /dev/sdb" }, output: "disk list\n/dev/sdb2  apfs  ...", handle: 1 },
    { id: "c2", tool: "read", input: { path: "notes.md", offset: 3 }, output: lines(120), handle: 2 },
  );
  s.calls(
    { id: "c3", tool: "bash", input: { command: "apfs-fuse /dev/sdb2 /mnt/mac\necho done" }, output: "apfs-fuse: no such device", isError: true, handle: 3 },
    { id: "c4", tool: "submit_result", input: { summary: "apfs" }, output: "Result recorded.", handle: 4 },
    { id: "c5", tool: "read", input: { path: "pic.png" }, content: [{ type: "text", text: "apfs image" }, { type: "image", data: "…" }], handle: 5 },
  );
  return { s, index: indexBranch(s.entries, s.leafId, ["submit_result"]) };
}

test("input summary and input lines", () => {
  assert.equal(inputSummary({ toolName: "bash", input: { command: "a\nb" } }), "a…");
  assert.equal(inputSummary({ toolName: "edit", input: { path: "x.ts", edits: [] } }), "x.ts");
  assert.equal(inputSummary({ toolName: "mcp", input: { q: "x" } }), '{"q":"x"}');
  assert.equal(inputSummary({ toolName: "mcp", input: undefined }), "(call not found)");
  assert.equal(inputSummary({ toolName: "mcp", input: { q: "x".repeat(200) } }).length, 101);
  assert.deepEqual(inputLines({ toolName: "bash", input: { command: "a\nb" } }), ["a", "b"]);
  assert.deepEqual(inputLines({ toolName: "write", input: { path: "f", content: "1\n2" } }), ["path: f", "content: 1", "2"]);
  assert.deepEqual(inputLines({ toolName: "bash", input: { command: "ls", timeout: 5 } }), ["command: ls", "timeout: 5"]);
});

test("get: header, numbered output, multi-line input cut in the header", () => {
  const { index } = session();
  const { text } = formatGetMany(index, [1, 3]);
  assert.equal(
    text,
    [
      "#1 bash ok · input: apfs-fuse -l /dev/sdb",
      "output (2 lines):",
      "1  disk list",
      "2  /dev/sdb2  apfs  ...",
      "",
      "#3 bash ERR · input: apfs-fuse /dev/sdb2 /mnt/mac…",
      "output (1 line):",
      "1  apfs-fuse: no such device",
    ].join("\n"),
  );
});

test("get: line ranges, negative ranges, out-of-range", () => {
  const { index } = session();
  const mid = formatGetMany(index, [2], { lines: [41, 43] }).text.split("\n");
  assert.deepEqual(mid.slice(1), ["output lines 41-43 of 120:", "41  line 41", "42  line 42", "43  line 43"]);
  const tail = formatGetMany(index, [2], { lines: [-2, -1] }).text.split("\n");
  assert.deepEqual(tail.slice(1), ["output lines 119-120 of 120:", "119  line 119", "120  line 120"]);
  assert.match(formatGetMany(index, [2], { lines: [200, 210] }).text, /lines 200\.\.210 are outside 1-120/);
});

test("get: maxChars cuts at a line and says how to get the rest", () => {
  const { index } = session();
  const { text, results } = formatGetMany(index, [2], { maxChars: 100 });
  assert.match(text, /output lines 1-\d+ of 120:/);
  const shownTo = Number(/output lines 1-(\d+)/.exec(text)![1]);
  assert.ok(shownTo > 3 && shownTo < 20);
  assert.match(text, new RegExp(`… lines ${shownTo + 1}-120 not shown \\(maxChars 100\\); request lines \\[${shownTo + 1}, 120\\]`));
  assert.equal((results[0] as { cut: boolean }).cut, true);
  // A tail request keeps the end.
  const tail = formatGetMany(index, [2], { lines: [-50, -1], maxChars: 60 }).text;
  assert.match(tail, /120  line 120$/m);
  assert.match(tail, /… lines 71-\d+ not shown/);
});

test("get: part input / both; lines apply to output only", () => {
  const { index } = session();
  assert.equal(formatGetMany(index, [2], { part: "input" }).text, "#2 read ok\ninput:\npath: notes.md\noffset: 3");
  const both = formatGetMany(index, [3], { part: "both", lines: [1, 1] }).text;
  assert.equal(both, "#3 bash ERR\ninput:\napfs-fuse /dev/sdb2 /mnt/mac\necho done\noutput (1 line):\n1  apfs-fuse: no such device");
});

test("get: per-ref errors inline; more than 10 refs is an error", () => {
  const { index } = session();
  const { text, results } = formatGetMany(index, [4, 99, 1]);
  assert.match(text, /^#4 is a submit_result call, which tool-ref does not show \(toolRef.exclude\)\n\n#99 is unknown.*\n\n#1 bash ok/);
  assert.equal(results.length, 3);
  assert.throws(() => formatGetMany(index, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), /At most 10 refs/);
});

test("get: empty output", () => {
  const s = new TestSession();
  s.calls({ id: "e", tool: "bash", input: { command: "true" }, output: "", handle: 1 });
  assert.equal(formatGetMany(indexBranch(s.entries, s.leafId, []), [1]).text, "#1 bash ok · input: true\noutput: (none)");
});

function grep(options: GrepOptions, format = {}) {
  const { index } = session();
  return formatGrep(grepRefs(index, options), { context: options.context, ...format }).text;
}

test("grep: newest first, in/out line numbers, excluded and images skipped", () => {
  assert.equal(
    grep({ pattern: "apfs" }),
    [
      "#5 read ok   pic.png",
      "  out:1  apfs image",
      "#3 bash ERR  apfs-fuse /dev/sdb2 /mnt/mac…",
      "  in:1   apfs-fuse /dev/sdb2 /mnt/mac",
      "  out:1  apfs-fuse: no such device",
      "#1 bash ok   apfs-fuse -l /dev/sdb",
      "  in:1   apfs-fuse -l /dev/sdb",
      "  out:2  /dev/sdb2  apfs  ...",
    ].join("\n"),
  );
  assert.equal(grep({ pattern: "^\\[image\\]$" }), "No matches.");
});

test("grep: smart case", () => {
  assert.equal(compilePattern("apfs").flags, "i");
  assert.equal(compilePattern("Apfs").flags, "");
  assert.equal(compilePattern("\\S+\\d").flags, "i");
  assert.match(grep({ pattern: "DISK" }), /No matches/);
  assert.match(grep({ pattern: "disk" }), /out:1  disk list/);
  assert.throws(() => grep({ pattern: "(" }), /Invalid pattern "\("/);
});

test("grep: in, tool, errors, refs filters", () => {
  assert.doesNotMatch(grep({ pattern: "apfs", in: "input" }), /out:/);
  assert.doesNotMatch(grep({ pattern: "apfs", in: "output" }), /in:/);
  assert.doesNotMatch(grep({ pattern: "apfs", tool: "read" }), /bash/);
  assert.match(grep({ pattern: "apfs", tool: ["read", "bash"] }), /#5[\s\S]*#3[\s\S]*#1/);
  assert.equal(grep({ pattern: "apfs", errors: true }).split("\n")[0], "#3 bash ERR  apfs-fuse /dev/sdb2 /mnt/mac…");
  assert.doesNotMatch(grep({ pattern: "apfs", errors: false }), /#3/);
  const byRef = grep({ pattern: "apfs", refs: [1, 4, 77] });
  assert.match(byRef, /^#4 is a submit_result call.*\n#77 is unknown.*\n#1 bash ok/);
  assert.throws(() => grep({ pattern: ".", refs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }), /At most 10 refs/);
});

test("grep: listing commands with pattern '.' and in: input", () => {
  assert.equal(
    grep({ pattern: ".", in: "input", tool: "bash" }),
    [
      "#3 bash ERR  apfs-fuse /dev/sdb2 /mnt/mac…",
      "  in:1  apfs-fuse /dev/sdb2 /mnt/mac",
      "  in:2  echo done",
      "#1 bash ok   apfs-fuse -l /dev/sdb",
      "  in:1  apfs-fuse -l /dev/sdb",
    ].join("\n"),
  );
});

test("grep: context lines with separators", () => {
  assert.equal(
    grep({ pattern: "^line (50|53)$", refs: [2], context: 1 }),
    ["#2 read ok   notes.md", "  out-49  line 49", "  out:50  line 50", "  out-51  line 51", "  out-52  line 52", "  out:53  line 53", "  out-54  line 54"].join(
      "\n",
    ),
  );
  assert.match(grep({ pattern: "^line (10|20)$", refs: [2], context: 1 }), /out-11  line 11\n  --\n  out-19/);
});

test("grep: per-call and total caps with the '… N more' line", () => {
  const text = grep({ pattern: "line" });
  assert.equal(text.split("\n").filter((l) => l.startsWith("  out:")).length, 5);
  assert.match(text, /… 115 more matches in 1 call \(narrow with tool\/refs\/in/);
  const capped = grep({ pattern: "a" }, { total: 2 });
  assert.equal(
    capped,
    "#5 read ok   pic.png\n  in:1   path: pic.png\n  out:1  apfs image\n" +
      "… 5 more matches in 3 calls (narrow with tool/refs/in, or read a call with tool_ref_get and lines)",
  );
});

test("grep: long lines cut to a window around the match", () => {
  const s = new TestSession();
  s.calls({ id: "j", tool: "bash", input: { command: "cat x.json" }, output: `${"a".repeat(1000)}NEEDLE${"b".repeat(1000)}`, handle: 1 });
  const text = formatGrep(grepRefs(indexBranch(s.entries, s.leafId, []), { pattern: "NEEDLE" })).text;
  const line = text.split("\n")[1];
  assert.match(line, /^  out:1  …a+NEEDLEb+…$/);
  assert.ok(line.length < 220);
});

test("grep: results without a usable handle show #?", () => {
  const s = new TestSession();
  const root = s.user("go");
  s.calls({ id: "a", tool: "bash", output: "hit", handle: 3 });
  s.branchFrom(root);
  s.calls({ id: "b", tool: "bash", input: { command: "x" }, output: "hit", handle: 3 }, { id: "c", tool: "bash", input: { command: "y" }, output: "hit" });
  const text = formatGrep(grepRefs(indexBranch(s.entries, s.leafId, []), { pattern: "hit" })).text;
  assert.equal(text, "#? bash ok   y\n  out:1  hit\n#? bash ok   x\n  out:1  hit");
});

test("/ref arguments: handles with or without #, spaces or commas", async () => {
  const { parseRefArgs } = await import("./format.ts");
  assert.deepEqual(parseRefArgs("12"), [12]);
  assert.deepEqual(parseRefArgs(" #12, 14 #3 "), [12, 14, 3]);
  for (const bad of ["", "abc", "12 x", "0", "-1", "1.5"]) assert.throws(() => parseRefArgs(bad), /Usage: \/ref <N>/, bad);
  assert.throws(() => parseRefArgs("1 2 3 4 5 6 7 8 9 10 11"), /At most 10/);
});

test("/ref view: whole input and output, details, excluded calls shown, errors inline", async () => {
  const { formatRefView } = await import("./format.ts");
  const { index } = session();
  const text = formatRefView(index, [3, 4, 2, 99]);
  // Refs start with a ──── header line (or are an error line), parts are split by blank lines.
  const [bash, submit, read, unknown] = text.split(/\n\n(?=────|#)/);
  assert.equal(
    bash,
    [
      "──── #3 bash ERR ────",
      `call c3 · started ${index.byHandle.get(3)!.startedAt} · entry ${index.byHandle.get(3)!.entryId}`,
      "",
      "input:",
      "apfs-fuse /dev/sdb2 /mnt/mac",
      "echo done",
      "",
      "output (1 line):",
      "1  apfs-fuse: no such device",
    ].join("\n"),
  );
  assert.match(submit, /^──── #4 submit_result ok ────\n.*excluded from tool_ref_get\/grep\n\ninput:\nsummary: apfs\n\noutput \(1 line\):\n1  Result recorded\.$/);
  // No character cap: all 120 lines.
  assert.match(read, /output \(120 lines\):[\s\S]*120  line 120$/);
  assert.doesNotMatch(read, /not shown/);
  assert.match(unknown, /^#99 is unknown/);
});

test("/ref view blocks: code marked for highlighting, other text plain", async () => {
  const { refViewSections } = await import("./format.ts");
  const s = new TestSession();
  s.user("go");
  s.calls(
    { id: "r1", tool: "read", input: { path: "src/a.ts" }, output: "const a = 1;\nexport { a };\n\n[Showing lines 1-2 of 9. Use offset=3 to continue.]", handle: 1 },
    { id: "w1", tool: "write", input: { path: "b.py", content: "x = 1\ny = 2" }, output: "Wrote b.py", handle: 2 },
    { id: "e1", tool: "edit", input: { path: "c.go", edits: [{ oldText: "a", newText: "b\nc" }] }, output: "ok", handle: 3 },
    { id: "b1", tool: "bash", input: { command: "ls -la", timeout: 5 }, output: "total 0", handle: 4 },
    { id: "r2", tool: "read", input: { path: "missing.ts" }, output: "ENOENT", isError: true, handle: 5 },
  );
  const index = indexBranch(s.entries, s.leafId, []);
  const [read, write, edit, bash, failed] = refViewSections(index, [1, 2, 3, 4, 5]);
  const code = (sec: typeof read) => sec!.blocks!.filter((b) => b.kind === "code");

  // read: file content is code of the file's language; the trailing notice is a plain block.
  assert.deepEqual(code(read), [
    { kind: "code", lines: ["const a = 1;", "export { a };"], gutter: ["1  ", "2  "], file: "src/a.ts" },
    { kind: "code", lines: ["", "[Showing lines 1-2 of 9. Use offset=3 to continue.]"], gutter: ["3  ", "4  "] },
  ]);
  assert.match(read!.text, /output \(4 lines\):\n1  const a = 1;\n2  export \{ a \};\n3  \n4  \[Showing/);

  assert.deepEqual(code(write)[0], { kind: "code", lines: ["x = 1", "y = 2"], file: "b.py" });
  assert.match(write!.text, /input:\npath: b\.py\ncontent:\nx = 1\ny = 2\n/);
  assert.equal(code(write)[1]!.kind === "code" && code(write)[1]!.file, undefined, "write output is not code");

  assert.match(edit!.text, /edits\[0\]\.oldText:\na\nedits\[0\]\.newText:\nb\nc\n/);
  assert.deepEqual(code(edit).slice(0, 2).map((b) => b.kind === "code" && b.file), ["c.go", "c.go"]);

  assert.deepEqual(code(bash)[0], { kind: "code", lines: ["ls -la"], lang: "bash" });
  assert.match(bash!.text, /input:\ncommand:\nls -la\ntimeout: 5\n/);
  // bash output has no language: plain.
  assert.equal(code(bash)[1]!.kind === "code" && (code(bash)[1]!.lang ?? code(bash)[1]!.file), undefined);

  // Failed reads are not highlighted.
  assert.equal(code(failed).at(-1)!.kind === "code" && code(failed).at(-1)!.file, undefined);
});
