import { test } from "node:test";
import assert from "node:assert/strict";
import { indexBranch, indexSessionFile, loadSettings, maxHandle, resolveHandle } from "./resolver.ts";
import { TestSession } from "./test-session.ts";

const EXCLUDE = ["submit_result"];

test("loadSettings: default, custom list, invalid values", () => {
  assert.deepEqual(loadSettings({}), { exclude: ["submit_result"] });
  assert.deepEqual(loadSettings(undefined), { exclude: ["submit_result"] });
  assert.deepEqual(loadSettings({ toolRef: { exclude: ["a", "b"] } }), { exclude: ["a", "b"] });
  assert.deepEqual(loadSettings({ toolRef: { exclude: [] } }), { exclude: [] });
  assert.deepEqual(loadSettings({ toolRef: { exclude: "a" } }), { exclude: ["submit_result"] });
});

test("indexes the branch: input, output without trailer, timing, entry id", () => {
  const s = new TestSession();
  s.user("go");
  const [bashId] = s.calls(
    { id: "c1", tool: "bash", input: { command: "ls" }, output: "a\nb", handle: 1, durationMs: 12 },
    { id: "c2", tool: "read", input: { path: "x" }, output: "ENOENT", isError: true, handle: 2 },
  );
  const index = indexBranch(s.entries, s.leafId, EXCLUDE);
  assert.equal(index.refs.length, 2);
  const ref = index.byHandle.get(1)!;
  assert.equal(ref.toolCallId, "c1");
  assert.equal(ref.toolName, "bash");
  assert.deepEqual(ref.input, { command: "ls" });
  assert.equal(ref.output, "a\nb");
  assert.deepEqual(ref.content, [{ type: "text", text: "a\nb" }]);
  assert.equal(ref.durationMs, 12);
  assert.equal(ref.entryId, bashId);
  assert.ok(ref.startedAt! < ref.endedAt!);
  assert.equal(index.byHandle.get(2)!.isError, true);
  assert.equal(index.byToolCallId.get("c2"), index.byHandle.get(2));
});

test("images appear as [image]; results without a trailer are indexed by toolCallId only", () => {
  const s = new TestSession();
  s.calls(
    { id: "img", tool: "read", content: [{ type: "image", data: "…", mimeType: "image/png" }], handle: 1 },
    { id: "old", tool: "bash", output: "before tool-ref" },
  );
  const index = indexBranch(s.entries, s.leafId, EXCLUDE);
  assert.equal(index.byHandle.get(1)!.output, "[image]");
  assert.equal(index.byHandle.size, 1);
  assert.equal(index.byToolCallId.get("old")!.handle, undefined);
});

test("trailers quoted in user, assistant and custom messages don't define handles", () => {
  const s = new TestSession();
  s.user("[tool-ref #5]");
  s.message({ role: "assistant", content: [{ type: "text", text: "[tool-ref #6]" }] });
  s.message({ role: "custom", customType: "x", content: [{ type: "text", text: "[tool-ref #7]" }] });
  s.calls({ id: "c1", tool: "bash", output: "ok", handle: 1 });
  const index = indexBranch(s.entries, s.leafId, EXCLUDE);
  assert.deepEqual([...index.byHandle.keys()], [1]);
  assert.equal(maxHandle(s.entries), 1);
});

test("excluded tools are indexed with excluded: true; get says why", () => {
  const s = new TestSession();
  s.calls(
    { id: "c1", tool: "submit_result", output: "Result recorded.", handle: 1 },
    { id: "c2", tool: "tool_ref_get", output: "…", handle: 2 },
    { id: "c3", tool: "mine", output: "…", handle: 3 },
  );
  const index = indexBranch(s.entries, s.leafId, ["submit_result", "mine"]);
  assert.equal(index.byHandle.get(1)!.excluded, true);
  assert.match(resolveHandle(index, 1).error!, /#1 is a submit_result call, which tool-ref does not show \(toolRef.exclude\)/);
  assert.match(resolveHandle(index, 2).error!, /#2 is a tool_ref_get call/);
  assert.match(resolveHandle(index, 3).error!, /#3 is a mine call/);
  // With the default list, `mine` is readable.
  assert.equal(resolveHandle(indexBranch(s.entries, s.leafId, EXCLUDE), 3).ref?.toolName, "mine");
});

test("only the active branch is visible; other branches say so", () => {
  const s = new TestSession();
  const root = s.user("go");
  s.calls({ id: "a", tool: "bash", output: "old branch", handle: 1 });
  s.branchFrom(root);
  s.calls({ id: "b", tool: "bash", output: "new branch", handle: 2 });
  const index = indexBranch(s.entries, s.leafId, EXCLUDE);
  assert.deepEqual(index.refs.map((r) => r.toolCallId), ["b"]);
  assert.equal(resolveHandle(index, 1).error, "#1 is not on the active branch");
  assert.equal(resolveHandle(index, 9).error, "#9 is unknown (no tool result has this number)");
  assert.equal(maxHandle(s.entries), 2);
});

test("duplicate handles anywhere in the file are ambiguous, indexed by toolCallId only", () => {
  const s = new TestSession();
  const root = s.user("go");
  s.calls({ id: "a", tool: "bash", output: "x", handle: 3 });
  s.branchFrom(root);
  s.calls({ id: "b", tool: "bash", output: "y", handle: 3 }, { id: "c", tool: "bash", output: "[tool-ref #40]" });
  const index = indexBranch(s.entries, s.leafId, EXCLUDE);
  assert.equal(resolveHandle(index, 3).error, "#3 is ambiguous (2 results claim it)");
  assert.equal(index.byToolCallId.get("b")!.ambiguous, true);
  assert.equal(index.byHandle.has(3), false);
  // A tool output that is exactly a trailer still raises the counter scan (harmless).
  assert.equal(maxHandle(s.entries), 40);
});

test("compaction and context edits don't hide anything (raw entries)", () => {
  const s = new TestSession();
  const [result] = s.calls({ id: "a", tool: "bash", input: { command: "cat log" }, output: "secret line", handle: 1 });
  s.entry("context_edit", { targetId: result, replacement: { content: [{ type: "text", text: "[cut]" }] } });
  s.entry("compaction", { summary: "…", firstKeptEntryId: s.leafId });
  s.calls({ id: "b", tool: "bash", output: "later", handle: 2 });
  const index = indexBranch(s.entries, s.leafId, EXCLUDE);
  assert.equal(index.byHandle.get(1)!.output, "secret line");
});

test("offline index from JSONL equals the live index, leaf = last entry", () => {
  const s = new TestSession();
  const root = s.user("go");
  s.calls({ id: "a", tool: "bash", output: "x", handle: 1 });
  s.branchFrom(root);
  s.calls({ id: "b", tool: "bash", output: "y", handle: 2 });
  const offline = indexSessionFile(s.jsonl(), EXCLUDE);
  assert.deepEqual(offline, indexBranch(s.entries, s.leafId, EXCLUDE));
  // /tree navigation without a summary moves the live leaf only; the file still ends at "b".
  s.branchFrom(root);
  assert.deepEqual(indexSessionFile(s.jsonl(), EXCLUDE).refs.map((r) => r.toolCallId), ["b"]);
});
