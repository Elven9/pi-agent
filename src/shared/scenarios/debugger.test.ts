import assert from "node:assert/strict";
import test from "node:test";
import { detailErrors } from "../result.ts";
import { debuggerScenario } from "./debugger.ts";
import { getScenario, scenarioNames } from "./index.ts";

test("debugger is registered", () => {
  assert.ok(scenarioNames().includes("debugger"));
  assert.equal(getScenario("debugger"), debuggerScenario);
  assert.equal(debuggerScenario.detailKind, "debugger/v1");
  assert.deepEqual(debuggerScenario.tools, ["codemode", "read", "bash"]);
});

test("debugger validates detail", () => {
  assert.deepEqual(detailErrors(debuggerScenario, { rootCause: "off-by-one in loop", evidence: ["src/a.ts:12"] }), []);
  assert.notDeepEqual(detailErrors(debuggerScenario, {}), []);
  assert.notDeepEqual(detailErrors(debuggerScenario, { rootCause: "", evidence: [] }), []);
  assert.notDeepEqual(detailErrors(debuggerScenario, { rootCause: "x", evidence: [], extra: 1 }), []);
});
