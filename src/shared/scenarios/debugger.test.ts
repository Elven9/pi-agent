import assert from "node:assert/strict";
import test from "node:test";
import { detailErrors } from "../result.ts";
import { debuggerScenario } from "./debugger.ts";
import { getScenario, scenarioNames } from "./index.ts";

test("debugger is registered", () => {
  assert.ok(scenarioNames().includes("debugger"));
  assert.equal(getScenario("debugger"), debuggerScenario);
  assert.equal(debuggerScenario.detailKind, "debugger/v2");
  assert.deepEqual(debuggerScenario.tools, ["codemode", "read", "bash"]);
});

test("debugger validates detail: findings required, root cause optional", () => {
  assert.deepEqual(detailErrors(debuggerScenario, { findings: ["src/a.ts:12 reads the port from env"] }), []);
  assert.deepEqual(detailErrors(debuggerScenario, { findings: ["src/a.ts:4 uses >"], rootCause: "off-by-one" }), []);
  assert.notDeepEqual(detailErrors(debuggerScenario, {}), []);
  assert.notDeepEqual(detailErrors(debuggerScenario, { findings: [] }), []);
  assert.notDeepEqual(detailErrors(debuggerScenario, { findings: ["x"], rootCause: "" }), []);
  assert.notDeepEqual(detailErrors(debuggerScenario, { findings: ["x"], extra: 1 }), []);
});
