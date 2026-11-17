import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY } from "./protocol.ts";
import { sameEntry, sessionProject, sessionScenario } from "./session-setup.ts";

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
  assert.deepEqual(sessionScenario(entries), { version: 1, name: "b" });
  assert.deepEqual(sessionProject(entries), local);
  assert.equal(sessionScenario([]), undefined);
  assert.equal(sessionProject([{ type: "custom_message", customType: ENTRY.project, data: local }]), undefined);
  assert.ok(sameEntry(local, { ...local }));
  assert.ok(!sameEntry(local, { ...local, source: { kind: "local", dir: "/q" } }));
});
