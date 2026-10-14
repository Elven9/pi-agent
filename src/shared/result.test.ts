import { test } from "node:test";
import assert from "node:assert/strict";
import { getScenario } from "./scenarios/index.ts";
import { detailErrors, validateResult } from "./result.ts";

const demo = getScenario("demo");

test("validateResult accepts a well-formed demo result", () => {
  const result = { summary: "s", detailKind: "demo/v1", detail: { projectName: "x", filesRead: ["a"] } };
  assert.deepEqual(validateResult(demo, result), []);
});

test("validateResult reports schema errors and a wrong detailKind", () => {
  assert.deepEqual(validateResult(demo, null), ["result is not an object"]);
  const errors = validateResult(demo, { summary: 1, detailKind: "demo/v0", detail: { projectName: "x" } });
  assert.ok(errors.some((e) => e.startsWith("/summary")), errors.join("\n"));
  assert.ok(errors.some((e) => e.includes("filesRead")), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("detailKind")), errors.join("\n"));
});

test("detailErrors reports paths under /detail", () => {
  assert.deepEqual(detailErrors(demo, { projectName: "x", filesRead: [] }), []);
  const errors = detailErrors(demo, { projectName: 1 });
  assert.ok(errors.length > 0 && errors.every((e) => e.startsWith("/detail")), errors.join("\n"));
});

test("getScenario rejects unknown names", () => {
  assert.throws(() => getScenario("nope"), /Unknown scenario "nope" \(known: demo, work-request-triage, code-writer\)/);
});
