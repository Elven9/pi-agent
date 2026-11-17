import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMMAND, createQuickQuit } from "./index.ts";

test("/q! exits with 0 at once, without asking pi to shut down", async () => {
  const commands = new Map<string, any>();
  const pi = { registerCommand: (name: string, options: any) => void commands.set(name, options) } as unknown as ExtensionAPI;
  const exits: number[] = [];
  createQuickQuit((code) => void exits.push(code))(pi);
  let shutdown = false;
  const ctx = { mode: "json", shutdown: () => (shutdown = true), sessionManager: { getSessionFile: () => undefined } };
  await commands.get(COMMAND).handler("", ctx);
  assert.equal(COMMAND, "q!");
  assert.deepEqual(exits, [0]);
  assert.equal(shutdown, false);
});
