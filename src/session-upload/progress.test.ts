import { test } from "node:test";
import assert from "node:assert/strict";
import { progressLine, seconds } from "./progress.ts";

test("progressLine: spinner frame and elapsed seconds", () => {
  assert.equal(progressLine(0), "⠋ Uploading session… 0.0s");
  assert.equal(progressLine(1234), "⠹ Uploading session… 1.2s");
  assert.equal(seconds(15000), "15.0s");
});
