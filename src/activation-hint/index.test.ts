import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activationHint, { activationMessage } from "./index.ts";
import { PROJECT_CHANNEL, SCENARIO_CHANNEL } from "../shared/protocol.ts";

function setup(mode = "tui") {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const notes: Array<{ message: string; type?: string }> = [];
  const pi = {
    events: {
      on: (channel: string, l: (data: unknown) => void) => void listeners.set(channel, [...(listeners.get(channel) ?? []), l]),
    },
    on: (event: string, h: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_start") handlers.push(h);
    },
  } as unknown as ExtensionAPI;
  activationHint(pi);
  const ctx = { mode, ui: { notify: (message: string, type?: string) => notes.push({ message, type }) } };
  return {
    notes,
    emit: (channel: string, data: unknown) => listeners.get(channel)?.forEach((l) => l(data)),
    start: () => handlers.forEach((h) => h({ type: "session_start", reason: "startup" }, ctx)),
  };
}

test("nothing active: no hint", () => {
  const s = setup();
  s.emit(PROJECT_CHANNEL, { block: "" });
  s.start();
  assert.deepEqual(s.notes, []);
});

test("scenario and project: one info hint with both", () => {
  const s = setup();
  s.emit(SCENARIO_CHANNEL, { name: "code-writer" });
  s.emit(PROJECT_CHANNEL, { project: { name: "demo", dir: "/p/demo" }, block: "" });
  s.start();
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].type, "info");
  assert.match(s.notes[0].message, /Scenario: code-writer/);
  assert.match(s.notes[0].message, /Project: demo \(\/p\/demo\)/);
});

test("state is per session start", () => {
  const s = setup();
  s.emit(SCENARIO_CHANNEL, { name: "code-writer" });
  s.start();
  s.start();
  assert.equal(s.notes.length, 1);
});

test("not in TUI: no hint", () => {
  const s = setup("json");
  s.emit(SCENARIO_CHANNEL, { name: "code-writer" });
  s.start();
  assert.deepEqual(s.notes, []);
});

test("activationMessage: only one of them", () => {
  assert.equal(activationMessage("x"), "Scenario: x (its system prompt, tools and skills are active)");
  assert.equal(activationMessage(undefined, { name: "p", dir: "r@v1" }), "Project: p (r@v1); /project shows its context");
  assert.equal(activationMessage(), undefined);
});
