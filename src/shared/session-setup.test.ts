import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY } from "./protocol.ts";
import { decideSetup, projectKey, sameEntry, sessionProject, sessionScenario } from "./session-setup.ts";

const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });

test("sessionScenario / sessionProject: the last valid entry in the file, else undefined", () => {
  const local = { version: 1, name: "p", source: { kind: "local", dir: "/p" } };
  const entries = [
    custom(ENTRY.scenario, { version: 1, name: "a" }),
    custom(ENTRY.project, local),
    { type: "message" },
    custom(ENTRY.scenario, { version: 1, name: "b" }),
    custom(ENTRY.scenario, null),
    custom(ENTRY.project, { version: 1, name: 3 }),
  ];
  assert.equal(sessionScenario(entries), "b");
  assert.deepEqual(sessionProject(entries), local);
  assert.equal(sessionScenario([]), undefined);
  assert.equal(sessionProject([{ type: "custom_message", customType: ENTRY.project, data: local }]), undefined);
  assert.ok(sameEntry(local, { ...local }));
  assert.ok(!sameEntry(local, { ...local, source: { kind: "local", dir: "/q" } }));
});

test("decideSetup: rules 1-3, resume/fork/reload use the record, /new the process, override", () => {
  const d = (reason: Parameters<typeof decideSetup>[0]["reason"], recorded?: string, current?: string, allowChange = false) =>
    decideSetup({ what: "scenario", reason, recorded, current, key: (s) => s, label: (s) => s, allowChange });
  // 1. none recorded: the process's, also when it adds one.
  assert.deepEqual(d("startup", undefined, "a"), { use: "current" });
  assert.deepEqual(d("resume", undefined, "a"), { use: "current" });
  // same one: fine.
  assert.deepEqual(d("startup", "a", "a"), { use: "current" });
  // 2. dropped, 3. changed: errors at startup.
  assert.match((d("startup", "a") as { error: string }).error, /recorded with the scenario a, but none is set now\. .*--allow-setup-change to continue without it/);
  assert.match((d("startup", "a", "b") as { error: string }).error, /recorded with the scenario a, not b\. .*to switch to b\.$/);
  // override.
  assert.deepEqual(d("startup", "a", undefined, true), { use: "current" });
  assert.deepEqual(d("startup", "a", "b", true), { use: "current" });
  // in-session switches follow the record; /new is a new session.
  for (const reason of ["resume", "fork", "reload"] as const) assert.deepEqual(d(reason, "a", "b"), { use: "recorded" });
  assert.deepEqual(d("new", "a", "b"), { use: "current" });
});

test("projectKey: same folder, or same repository and folder (any tag)", () => {
  assert.equal(projectKey({ kind: "local", dir: "/p" }), "local:/p");
  assert.equal(projectKey({ kind: "remote", provider: "github", repo: "https://github.com/a/b", path: "x" }), "github:https://github.com/a/b/x");
  assert.equal(sessionScenario([custom(ENTRY.scenario, { version: 1, name: "a" }), custom(ENTRY.scenario, { version: 1, name: null })]), undefined);
});
