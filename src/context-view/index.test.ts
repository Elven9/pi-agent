import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextView from "./index.ts";
import { PROJECT_CHANNEL, SCENARIO_CHANNEL } from "../shared/protocol.ts";

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
function fakePi() {
  const handlers = new Map<string, () => void>();
  const listeners = new Map<string, (data: unknown) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const notices: string[] = [];
  let systemPrompt = "";
  const pi = {
    events: { on: (channel: string, fn: (data: unknown) => void) => void listeners.set(channel, fn) },
    on: (event: string, handler: () => void) => void handlers.set(event, handler),
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    getActiveTools: () => ["read", "bash", "submit_result"],
    getAllTools: () => [
      { name: "read", sourceInfo: { path: "builtin:read" } },
      { name: "bash", sourceInfo: { path: "builtin:bash" } },
      { name: "submit_result", sourceInfo: { path: "/ext/extension.js" } },
    ],
  } as unknown as ExtensionAPI;
  contextView(pi);
  const ctx = { getSystemPrompt: () => systemPrompt, ui: { notify: (m: string) => void notices.push(m) } };
  return {
    notices,
    emit: (event: string) => handlers.get(event)?.(),
    announce: (channel: string, data: unknown) => listeners.get(channel)?.(data),
    /** Runs a prompt: pi has now built the effective prompt `text`. */
    prompt(text: string) {
      handlers.get("before_agent_start")?.();
      systemPrompt = text;
    },
    setBasePrompt: (text: string) => void (systemPrompt = text),
    context: async () => {
      await commands.get("context")!.handler("", ctx);
      return notices.at(-1)!;
    },
  };
}

const PROMPT = "You are an expert coding assistant.\n\n<cwd>\n/w\n</cwd>";

test("plain pi: shows the default setup, base prompt before the first prompt", async () => {
  const pi = fakePi();
  pi.emit("session_start");
  pi.setBasePrompt(PROMPT);
  const before = await pi.context();
  assert.match(before, /scenario: \(none, pi's default prompt\)\nproject:  \(none\)\n/);
  assert.match(before, /tools \(3\): built-in \[read, bash\] · extensions \[submit_result\]/);
  assert.match(before, /Not built yet: this is pi's base prompt/);
  assert.match(before, /──── system prompt \(base\) ─+\nYou are an expert coding assistant\.\n\n<cwd>\n\/w\n<\/cwd>\n──── end/);

  pi.prompt(PROMPT);
  const after = await pi.context();
  assert.doesNotMatch(after, /Not built yet/);
  assert.match(after, /──── system prompt ─+\nYou are an expert/);
});

test("scenario and project: prompt split at block B", async () => {
  const pi = fakePi();
  pi.announce(SCENARIO_CHANNEL, { name: "code-writer" });
  const block = "<project>\nname: demo\n</project>";
  pi.announce(PROJECT_CHANNEL, { project: { name: "demo", dir: "/p" }, block: "" });
  pi.emit("session_start");
  assert.match(await pi.context(), /scenario: code-writer\nproject:  demo \(\/p\)\n/);

  pi.announce(PROJECT_CHANNEL, { project: { name: "demo", dir: "/p" }, block });
  pi.prompt(`You write code.\n\n<cwd>\n/w\n</cwd>\n\n${block}`);
  const text = await pi.context();
  assert.match(text, /block A ~\d+, block B ~\d+/);
  assert.match(
    text,
    /system prompt · block A \(shared\) ─+\nYou write code\.\n\n<cwd>\n\/w\n<\/cwd>\n──── block B \(project\) ─+\n<project>\nname: demo\n<\/project>\n──── end/,
  );
});

test("a new session needs a prompt again before the prompt is effective", async () => {
  const pi = fakePi();
  pi.prompt(PROMPT);
  pi.emit("session_start");
  assert.match(await pi.context(), /Not built yet/);
});
