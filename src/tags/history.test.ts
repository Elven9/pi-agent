import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACT_BYTES, foldHistory, folderTags, historyLine, historyPath, MAX_PER_FOLDER, otherTags, readHistory, recordTags } from "./history.ts";

const line = (cwd: string, tags: string[], at: string) => historyLine(cwd, tags, new Date(at));

test("historyPath: in the agent dir", () => {
  assert.equal(historyPath("/home/me/.pi/agent"), "/home/me/.pi/agent/pi-agent/tag-history.jsonl");
});

test("foldHistory: most recent first per folder, first tag of a line most recent, bad lines skipped", () => {
  const h = foldHistory(
    [
      line("/a", ["x", "y"], "2026-01-01T00:00:00Z"),
      "not json",
      JSON.stringify({ cwd: 1, tags: ["z"] }) + "\n",
      JSON.stringify({ cwd: "/a", tags: ["z", 3, ""] }) + "\n",
      line("/a", ["y"], "2026-01-03T00:00:00Z"),
      line("/b", ["x", "q"], "2026-01-02T00:00:00Z"),
      '{"cwd":"/a","tags":["par',
    ].join(""),
  );
  assert.deepEqual(folderTags(h, "/a"), ["y", "z", "x"]);
  assert.deepEqual(folderTags(h, "/b"), ["x", "q"]);
  assert.deepEqual(folderTags(h, "/none"), []);
});

test("foldHistory: at most MAX_PER_FOLDER tags per folder", () => {
  const text = Array.from({ length: 15 }, (_, i) => line("/a", [`t${i}`], "2026-01-01T00:00:00Z")).join("");
  const tags = folderTags(foldHistory(text), "/a");
  assert.equal(tags.length, MAX_PER_FOLDER);
  assert.equal(tags[0], "t14");
  assert.equal(tags.at(-1), "t5");
});

test("otherTags: other folders' tags by recency, each once", () => {
  const h = foldHistory(
    line("/b", ["old"], "2026-01-01T00:00:00Z") + line("/c", ["new", "old"], "2026-01-05T00:00:00Z") + line("/a", ["here"], "2026-01-09T00:00:00Z"),
  );
  assert.deepEqual(otherTags(h, "/a"), ["new", "old"]);
});

test("recordTags: appends (creating the folder), nothing for an empty list; readHistory of a missing file is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-tag-history-"));
  const path = join(dir, "sub", "h.jsonl");
  assert.equal((await readHistory(path)).size, 0);
  await recordTags(path, "/a", [], new Date());
  await assert.rejects(stat(path));
  await recordTags(path, "/a", ["x"], new Date("2026-01-01T00:00:00Z"));
  await recordTags(path, "/a", ["y"], new Date("2026-01-02T00:00:00Z"));
  assert.deepEqual(folderTags(await readHistory(path), "/a"), ["y", "x"]);
});

test("recordTags: compacts a large file to each folder's recent tags, keeping their order and times", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-tag-history-"));
  const path = join(dir, "h.jsonl");
  const filler = Array.from({ length: 2000 }, (_, i) => line("/a", [`t${i % 30}`], "2026-01-01T00:00:00Z")).join("");
  assert.ok(Buffer.byteLength(filler) > COMPACT_BYTES);
  await writeFile(path, filler);
  const before = foldHistory(filler + line("/b", ["b"], "2026-02-01T00:00:00Z"));
  await recordTags(path, "/b", ["b"], new Date("2026-02-01T00:00:00Z"));
  const text = await readFile(path, "utf8");
  assert.equal(text.trim().split("\n").length, MAX_PER_FOLDER + 1);
  assert.deepEqual(foldHistory(text), before);
});
