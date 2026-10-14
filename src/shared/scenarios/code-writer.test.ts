import assert from "node:assert/strict";
import test from "node:test";
import { detailErrors } from "../result.ts";
import { codeWriter } from "./code-writer.ts";
import { getScenario, scenarioNames } from "./index.ts";

test("code-writer is registered", () => {
  assert.ok(scenarioNames().includes("code-writer"));
  assert.equal(getScenario("code-writer"), codeWriter);
  assert.equal(codeWriter.detailKind, "code-writer/v1");
  assert.deepEqual(codeWriter.tools, ["read", "bash", "edit", "write"]);
});

test("code-writer validates detail", () => {
  assert.deepEqual(detailErrors(codeWriter, { filesChanged: ["src/a.ts"] }), []);
  assert.notDeepEqual(detailErrors(codeWriter, {}), []);
  assert.notDeepEqual(detailErrors(codeWriter, { filesChanged: [], extra: 1 }), []);
});
