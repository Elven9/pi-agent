import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY } from "./protocol.ts";
import { currentTags, normalizeTags, parseTags, sessionFileTags, tagHistory } from "./tags.ts";

const entry = (tags: unknown) => ({ type: "custom", customType: ENTRY.tags, data: { version: 1, tags, source: "command" } });

test("parseTags: trims, lowercases, drops empties and duplicates, keeps order", () => {
  assert.deepEqual(parseTags(" Bug, ui ,,bug,TICKET:abc-1 "), ["bug", "ui", "ticket:abc-1"]);
  assert.deepEqual(parseTags(""), []);
  assert.deepEqual(parseTags(" , "), []);
  assert.deepEqual(normalizeTags(["a/b", "x_y.z"]), ["a/b", "x_y.z"]);
});

test("parseTags: lists every invalid tag", () => {
  assert.throws(() => parseTags("ok,has space,é"), /Invalid tags "has space", "é": use up to 64 of a-z 0-9/);
  assert.throws(() => parseTags("x".repeat(65)), /Invalid tag "x{65}"/);
});

test("currentTags: the last tags entry wins; none means never tagged", () => {
  const entries = [entry(["a"]), { type: "message" }, entry(["b", "c"]), { type: "custom", customType: "other", data: { tags: ["z"] } }];
  assert.deepEqual(currentTags(entries), ["b", "c"]);
  assert.deepEqual(currentTags([...entries, entry([])]), []);
  assert.equal(currentTags([{ type: "message" }]), undefined);
  assert.deepEqual(currentTags([entry(["a"]), entry("bad")]), ["a"]);
  assert.deepEqual(tagHistory(entries), [["a"], ["b", "c"]]);
});

test("sessionFileTags: reads a JSONL session file, skipping other and broken lines", () => {
  const text = [
    JSON.stringify({ type: "session", id: "s" }),
    JSON.stringify(entry(["a"])),
    JSON.stringify({ type: "message", text: "talks about pi-agent.tags" }),
    JSON.stringify(entry(["b"])),
    '{"type":"custom","customType":"pi-agent.tags","data":{',
  ].join("\n");
  assert.deepEqual(sessionFileTags(text), ["b"]);
  assert.equal(sessionFileTags(""), undefined);
});
