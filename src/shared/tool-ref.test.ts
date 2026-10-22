import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHandle, trailerText, withoutTrailer } from "./tool-ref.ts";

const text = (t: string) => ({ type: "text", text: t });

test("trailer round trip", () => {
  assert.equal(trailerText(12), "[tool-ref #12]");
  assert.equal(parseHandle([text("out"), text(trailerText(12))]), 12);
});

test("only a whole text block counts, searched from the end", () => {
  // Output that only ends with a trailer line (cat of a session file) is not a handle.
  assert.equal(parseHandle([text("line\n[tool-ref #3]")]), undefined);
  assert.equal(parseHandle([text("[tool-ref #3] ")]), undefined);
  assert.equal(parseHandle([{ type: "image", data: "…", mimeType: "image/png" }]), undefined);
  assert.equal(parseHandle([]), undefined);
  assert.equal(parseHandle(undefined), undefined);
  assert.equal(parseHandle([text("[tool-ref #0]")]), undefined);
  // A block appended after the trailer keeps the handle; the last trailer block wins.
  assert.equal(parseHandle([text("[tool-ref #3]"), text("out"), text("[tool-ref #7]"), text("note")]), 7);
  // Image-only result with a trailer.
  assert.equal(parseHandle([{ type: "image", data: "…", mimeType: "image/png" }, text("[tool-ref #4]")]), 4);
});

test("withoutTrailer removes only the trailer block", () => {
  const content = [text("a"), text("[tool-ref #2]"), text("note")];
  assert.deepEqual(withoutTrailer(content), [text("a"), text("note")]);
  const plain = [text("a")];
  assert.equal(withoutTrailer(plain), plain);
});
