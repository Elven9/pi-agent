import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextView, { sessionSystemPrompt } from "./index.ts";
import { PROJECT_CHANNEL, SCENARIO_CHANNEL } from "../shared/protocol.ts";

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const branch: Array<{ type: string; message?: unknown }> = [];
  const listeners = new Map<string, (data: unknown) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const notices: string[] = [];
  let systemPrompt = "";
  const pi = {
    events: { on: (channel: string, fn: (data: unknown) => void) => void listeners.set(channel, fn) },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void handlers.set(event, handler),
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    getActiveTools: () => ["read", "bash", "submit_result"],
    getAllTools: () => [
      { name: "read", sourceInfo: { path: "builtin:read" } },
      { name: "bash", sourceInfo: { path: "builtin:bash" } },
      { name: "submit_result", sourceInfo: { path: "/ext/extension.js" } },
    ],
  } as unknown as ExtensionAPI;
  contextView(pi);
  const ctx = {
    getSystemPrompt: () => systemPrompt,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (m: string) => void notices.push(m) },
  };
  const emit = (event: string) => handlers.get(event)?.({ type: event }, ctx);
  return {
    notices,
    emit,
    announce: (channel: string, data: unknown) => listeners.get(channel)?.(data),
    /**
     * Runs a prompt like pi: records the effective prompt `text` in the session; afterwards
     * pi's getSystemPrompt() is the base prompt again (unchanged here).
     */
    prompt(text: string) {
      branch.push({ type: "message", message: { role: "system", content: text, timestamp: 0 } });
      branch.push({ type: "message", message: { role: "user", content: "hi", timestamp: 0 } });
    },
    /** A new session (/new): empty transcript. */
    newSession() {
      branch.length = 0;
      emit("session_start");
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
  assert.match(after, /──── system prompt \(last sent\) ─+\nYou are an expert/);
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
    /system prompt \(last sent\) · block A \(shared\) ─+\nYou write code\.\n\n<cwd>\n\/w\n<\/cwd>\n──── block B \(project\) ─+\n<project>\nname: demo\n<\/project>\n──── end/,
  );
});

test("after a run: shows the prompt that was sent, not pi's base prompt", async () => {
  const pi = fakePi();
  pi.announce(SCENARIO_CHANNEL, { name: "code-writer" });
  pi.emit("session_start");
  pi.setBasePrompt("BASE with <name>agent-browser</name>");
  pi.prompt("You write code. <name>golang</name>");
  const text = await pi.context();
  assert.match(text, /system prompt \(last sent\) ─+\nYou write code\. <name>golang<\/name>\n/);
  assert.doesNotMatch(text, /agent-browser|BASE/);
});

test("a new session needs a prompt again before the prompt is effective", async () => {
  const pi = fakePi();
  pi.prompt(PROMPT);
  pi.newSession();
  assert.match(await pi.context(), /Not built yet/);
});

test("sessionSystemPrompt replays pi's system messages: sections patched by name, removed with null", () => {
  const msg = (m: object) => ({ type: "message", message: { role: "system", content: "", timestamp: 0, ...m } });
  assert.equal(sessionSystemPrompt([]), undefined);
  assert.equal(sessionSystemPrompt([{ type: "message", message: { role: "user" } }, { type: "custom" }]), undefined);
  const { text, sections } = sessionSystemPrompt([
    msg({ sections: { preamble: "PRE", skills: "<name>agent-browser</name>", cwd: "<cwd>/w</cwd>" } }),
    { type: "message", message: { role: "user", content: "hi", timestamp: 0 } },
    msg({ sections: { skills: "<name>golang</name>", cwd: null } }),
  ])!;
  assert.equal(text, "PRE\n\n<name>golang</name>");
  assert.deepEqual(sections, [
    { name: "preamble", text: "PRE" },
    { name: "skills", text: "<name>golang</name>" },
  ]);
  // Leading content (a plain prompt) comes first, as its own part.
  assert.deepEqual(sessionSystemPrompt([msg({ content: "BASE", sections: { cwd: "C" } })]), {
    text: "BASE\n\nC",
    sections: [
      { name: "content", text: "BASE" },
      { name: "cwd", text: "C" },
    ],
  });
});
