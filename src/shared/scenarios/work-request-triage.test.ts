import assert from "node:assert/strict";
import test from "node:test";
import { detailErrors } from "../result.ts";
import { getScenario, scenarioNames } from "./index.ts";
import { workRequestTriage } from "./work-request-triage.ts";

const valid = {
  tasks: [
    {
      category: "bug_report",
      title: "Fix login timeout on Safari",
      description: "Login on Safari times out after submitting the form.",
      fields: [{ key: "environment", value: "Safari", evidence: "on Safari it just spins" }],
      missingInfo: ["Safari version"],
      priority: "high",
      confidence: "high",
    },
    {
      category: "feature_request",
      title: "Add CSV export to the reports page",
      description: "Users want to export the reports table as CSV.",
      fields: [],
      missingInfo: [],
      confidence: "medium",
    },
  ],
  clarifyingQuestions: ["Which Safari version are you on?"],
  needsHuman: false,
};

test("work-request-triage is registered with read only", () => {
  assert.ok(scenarioNames().includes("work-request-triage"));
  assert.equal(getScenario("work-request-triage"), workRequestTriage);
  assert.equal(workRequestTriage.detailKind, "work-request-triage/v1");
  assert.deepEqual(workRequestTriage.tools, ["read"]);
  assert.match(workRequestTriage.systemPrompt, /^You triage work requests\./);
});

test("work-request-triage accepts a valid detail", () => {
  assert.deepEqual(detailErrors(workRequestTriage, valid), []);
});

test("work-request-triage rejects unknown categories, missing evidence, empty tasks and extra keys", () => {
  const withTask = (patch: object) => ({ ...valid, tasks: [{ ...valid.tasks[0], ...patch }] });
  assert.notDeepEqual(detailErrors(workRequestTriage, withTask({ category: "bug" })), []);
  assert.notDeepEqual(detailErrors(workRequestTriage, withTask({ fields: [{ key: "k", value: "v" }] })), []);
  assert.notDeepEqual(detailErrors(workRequestTriage, withTask({ priority: "p0" })), []);
  assert.notDeepEqual(detailErrors(workRequestTriage, withTask({ extra: 1 })), []);
  assert.notDeepEqual(detailErrors(workRequestTriage, { ...valid, tasks: [] }), []);
  assert.notDeepEqual(detailErrors(workRequestTriage, { tasks: valid.tasks, needsHuman: false }), []);
});
