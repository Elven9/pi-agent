import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillLoads from "./index.ts";
import { ENTRY } from "../shared/protocol.ts";
import {
  firstText,
  formatSkillLoads,
  skillAt,
  skillCommandOf,
  skillLoadOf,
  summarizeSkillLoads,
} from "../shared/skill-loads.ts";

const GOLANG = { name: "golang", filePath: "/skills/golang/SKILL.md" };
const BROWSER = { name: "agent-browser", filePath: "/home/.agents/skills/agent-browser/SKILL.md" };

type Handler = (event: any, ctx: any) => unknown;

/** Minimal ExtensionAPI: handlers by event, appended entries, the registered command. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const entries: { type: string; customType: string; data: any; timestamp: string }[] = [];
  let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
  const pi = {
    on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
    appendEntry: (customType: string, data: unknown) =>
      void entries.push({ type: "custom", customType, data, timestamp: "2026-11-20T10:00:00.000Z" }),
    registerCommand: (name: string, c: any) => void (name === "skills-loaded" && (command = c)),
  } as unknown as ExtensionAPI;
  skillLoads(pi);
  const ctx = { cwd: "/work" };
  const emit = (event: string, data: object) => {
    for (const h of handlers.get(event) ?? []) h({ type: event, ...data }, ctx);
  };
  const loads = () => entries.filter((e) => e.customType === ENTRY.skillLoad).map((e) => e.data);
  /** One tool call through tool_call and tool_execution_end. */
  const call = (id: string, toolName: string, input: object, isError = false, parentToolCallId?: string) => {
    emit("tool_call", { toolCallId: id, toolName, input, parentToolCallId });
    emit("tool_execution_end", { toolCallId: id, toolName, result: {}, isError, parentToolCallId });
  };
  const run = (skills = [GOLANG, BROWSER]) => emit("before_agent_start", { messageType: "user", prompt: "p", systemPromptOptions: { skills } });
  return { emit, call, run, loads, entries, command: () => command! };
}

test("a read of a loaded SKILL.md is one entry per load: direct, from codemode, relative", () => {
  const pi = fakePi();
  pi.emit("session_start", {});
  pi.run();
  pi.call("c1", "read", { path: GOLANG.filePath });
  pi.call("c2/1", "read", { path: BROWSER.filePath }, false, "c2");
  pi.call("c3", "read", { path: "../skills/golang/SKILL.md" });
  assert.deepEqual(pi.loads(), [
    { version: 1, name: "golang", location: GOLANG.filePath, via: "read", toolCallId: "c1" },
    { version: 1, name: "agent-browser", location: BROWSER.filePath, via: "codemode", toolCallId: "c2/1" },
    { version: 1, name: "golang", location: GOLANG.filePath, via: "read", toolCallId: "c3" },
  ]);
});

test("not a load: failed or blocked read, other files, other tools, skills not in the prompt", () => {
  const pi = fakePi();
  pi.run([GOLANG]);
  pi.call("c1", "read", { path: GOLANG.filePath }, true);
  pi.call("c2", "read", { path: "/skills/golang/references/pattern.md" });
  pi.call("c3", "bash", { command: `cat ${GOLANG.filePath}` });
  pi.call("c4", "read", { path: BROWSER.filePath });
  pi.call("c5", "read", {});
  assert.deepEqual(pi.loads(), []);
});

test("skills are read when the call happens, so a later narrowing handler counts", () => {
  const pi = fakePi();
  const options = { skills: [GOLANG, BROWSER] };
  pi.emit("before_agent_start", { messageType: "user", prompt: "p", systemPromptOptions: options });
  options.skills = [BROWSER];
  pi.call("c1", "read", { path: GOLANG.filePath });
  pi.call("c2", "read", { path: BROWSER.filePath });
  assert.deepEqual(pi.loads().map((l) => l.name), ["agent-browser"]);
});

test("/skill:name: the user message pi expanded is a command load", () => {
  const pi = fakePi();
  const block = `<skill name="golang" location="${GOLANG.filePath}">\nReferences are relative to /skills/golang.\n\nbody\n</skill>\n\nfix it`;
  pi.emit("message_end", { message: { role: "user", content: [{ type: "text", text: block }] } });
  pi.emit("message_end", { message: { role: "user", content: "no skill here" } });
  pi.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: block }] } });
  assert.deepEqual(pi.loads(), [{ version: 1, name: "golang", location: GOLANG.filePath, via: "command" }]);
});

test("/skills-loaded lists the branch's loads", async () => {
  const pi = fakePi();
  pi.run();
  pi.call("c1", "read", { path: GOLANG.filePath });
  pi.call("c2/1", "read", { path: GOLANG.filePath }, false, "c2");
  const notes: string[] = [];
  await pi.command().handler("", { sessionManager: { getBranch: () => pi.entries }, ui: { notify: (m: string) => notes.push(m) } });
  assert.match(notes[0], /^Skills loaded on this branch: 1 skill, 2 loads\n {2}golang {2}2x \(read 1, codemode 1\), first at /);
  assert.match(notes[0], /\n {4}\/skills\/golang\/SKILL\.md$/);
});

test("skillAt compares real paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-loads-"));
  await mkdir(join(dir, "golang"));
  await writeFile(join(dir, "golang", "SKILL.md"), "x");
  await symlink(join(dir, "golang"), join(dir, "link"));
  const skill = { name: "golang", filePath: join(dir, "golang", "SKILL.md") };
  assert.equal(skillAt(join(dir, "link", "SKILL.md"), "/", [skill]), skill);
  assert.equal(skillAt("link/SKILL.md", dir, [skill]), skill);
  assert.equal(skillAt("golang/other.md", dir, [skill]), undefined);
});

test("readers: commands, message text, entries", () => {
  assert.deepEqual(skillCommandOf('<skill name="a" location="/s/a/SKILL.md">\nx'), { name: "a", location: "/s/a/SKILL.md" });
  assert.equal(skillCommandOf('text <skill name="a" location="/x">\n'), undefined);
  assert.equal(firstText("s"), "s");
  assert.equal(firstText([{ type: "image" }, { type: "text", text: "t" }]), "t");
  assert.equal(firstText(undefined), "");

  const entry = (data: unknown) => ({ type: "custom", customType: ENTRY.skillLoad, data });
  const ok = { version: 1, name: "a", location: "/a/SKILL.md", via: "read", toolCallId: "c" };
  assert.deepEqual(skillLoadOf(entry(ok)), ok);
  assert.equal(skillLoadOf(entry({ ...ok, version: 2 })), undefined);
  assert.equal(skillLoadOf(entry({ ...ok, via: "cat" })), undefined);
  assert.equal(skillLoadOf(entry({ ...ok, name: "" })), undefined);
  assert.equal(skillLoadOf(entry({ ...ok, toolCallId: 3 })), undefined);
  assert.equal(skillLoadOf({ type: "custom", customType: ENTRY.metrics, data: ok }), undefined);
  assert.equal(skillLoadOf(null), undefined);
});

test("summary groups by location in first-load order", () => {
  const e = (name: string, via: string, timestamp: string) => ({
    type: "custom", customType: ENTRY.skillLoad, timestamp, data: { version: 1, name, location: `/${name}/SKILL.md`, via },
  });
  const s = summarizeSkillLoads([e("b", "command", "t1"), { type: "message" }, e("a", "read", "t2"), e("b", "read", "t3")]);
  assert.deepEqual(s, [
    { name: "b", location: "/b/SKILL.md", loads: 2, via: { command: 1, read: 1 }, first: "t1" },
    { name: "a", location: "/a/SKILL.md", loads: 1, via: { read: 1 }, first: "t2" },
  ]);
  assert.equal(formatSkillLoads([]), "No skills loaded on this branch.");
});
