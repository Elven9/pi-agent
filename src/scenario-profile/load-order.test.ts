import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import scenarioProfile from "./index.ts";
import projectContext from "../project/index.ts";
import { ENTRY } from "../shared/protocol.ts";

type Factory = (pi: ExtensionAPI) => void;

/**
 * Loads the real extensions in the given order on one shared event bus and runs session_start
 * like pi: handlers in load order, each awaited before the next.
 */
async function startSession(order: Factory[], flags: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-order-"));
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const events = {
    emit: (channel: string, data: unknown) => listeners.get(channel)?.forEach((l) => l(data)),
    on: (channel: string, listener: (data: unknown) => void) =>
      void listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
  };
  const handlers: Array<{ event: string; handler: (event: any, ctx: any) => any }> = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  let shutdown = false;
  const pi = {
    events,
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.push({ event, handler }),
    registerCommand() {},
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read", sourceInfo: { path: "builtin:read" } }],
    setActiveTools() {},
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
  } as unknown as ExtensionAPI;
  for (const factory of order) factory(pi);
  const ctx = { cwd, shutdown: () => (shutdown = true) };
  const original = console.error;
  console.error = () => {};
  try {
    for (const { event, handler } of handlers) {
      if (event === "session_start") await handler({ type: "session_start", reason: "startup" }, ctx);
    }
  } finally {
    console.error = original;
  }
  return { entries, shutdown };
}

const scenario: Factory = (pi) => scenarioProfile(pi, "/pkg/skills");
const project: Factory = (pi) => projectContext(pi);

test("scenario-profile before project: no error", async () => {
  const run = await startSession([scenario, project], { scenario: "work-request-triage" });
  assert.equal(run.shutdown, false);
  assert.deepEqual(run.entries, []);
});

test("project before scenario-profile under --scenario: error entry and shutdown", async () => {
  const run = await startSession([project, scenario], { scenario: "work-request-triage" });
  assert.equal(run.shutdown, true);
  assert.equal(run.entries[0].customType, ENTRY.error);
  assert.match((run.entries[0].data as { message: string }).message, /must load before the project extension/);
});

test("project before scenario-profile without --scenario: not checked", async () => {
  const run = await startSession([project, scenario], {});
  assert.equal(run.shutdown, false);
  assert.deepEqual(run.entries, []);
});
