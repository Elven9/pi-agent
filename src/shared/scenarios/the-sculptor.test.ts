import assert from "node:assert/strict";
import test from "node:test";
import { detailErrors } from "../result.ts";
import { getScenario, scenarioNames } from "./index.ts";
import { theSculptor } from "./the-sculptor.ts";

const valid = {
  problem: "Cache invalidation across services",
  solutions: [{ title: "TTL cache", summary: "Expire entries after 60s.", pros: ["simple"], cons: ["stale reads"], risks: [] }],
  recommended: "TTL cache",
  openQuestions: [],
  documentsWritten: [],
};

test("the-sculptor is registered without edit", () => {
  assert.ok(scenarioNames().includes("the-sculptor"));
  assert.equal(getScenario("the-sculptor"), theSculptor);
  assert.equal(theSculptor.detailKind, "the-sculptor/v1");
  assert.deepEqual(theSculptor.tools, ["codemode", "read", "bash", "write"]);
  assert.match(theSculptor.rules?.[0] ?? "", /^Never write, edit or generate source code/);
  assert.doesNotMatch(theSculptor.systemPrompt, /## Rules/);
});

test("the-sculptor validates detail", () => {
  assert.deepEqual(detailErrors(theSculptor, valid), []);
  assert.notDeepEqual(detailErrors(theSculptor, { ...valid, solutions: [] }), []);
  assert.notDeepEqual(detailErrors(theSculptor, { ...valid, extra: 1 }), []);
});
