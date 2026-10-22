import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolRef from "./index.ts";
import { ENTRY, TOOL_RESULT_REWRITER_CHANNEL } from "../shared/protocol.ts";

type Factory = (pi: ExtensionAPI) => void;

/**
 * Loads the extensions in the given order on one shared event bus and runs session_start like
 * pi: handlers in load order, each awaited before the next.
 */
async function startSession(order: Factory[]) {
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
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.push({ event, handler }),
    registerTool() {},
    registerToolRenderer() {},
    getSettings: () => ({}),
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
  } as unknown as ExtensionAPI;
  for (const factory of order) factory(pi);
  const ctx = {
    sessionManager: { getSessionId: () => `order-${Math.random()}`, getEntries: () => [] },
    shutdown: () => (shutdown = true),
  };
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

/** A pi-agent extension whose message_end handler replaces tool results. */
const rewriter: Factory = (pi) => {
  pi.on("session_start", () => pi.events.emit(TOOL_RESULT_REWRITER_CHANNEL, { name: "redactor" }));
};

test("tool-ref after a tool-result rewriter: no error", async () => {
  const run = await startSession([rewriter, toolRef]);
  assert.equal(run.shutdown, false);
  assert.deepEqual(run.entries, []);
});

test("tool-ref before a tool-result rewriter: error entry and shutdown", async () => {
  const run = await startSession([toolRef, rewriter]);
  assert.equal(run.shutdown, true);
  assert.equal(run.entries[0].customType, ENTRY.error);
  assert.match((run.entries[0].data as { message: string }).message, /tool-ref extension must load after redactor/);
});
