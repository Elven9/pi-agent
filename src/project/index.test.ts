import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import projectContext from "./index.ts";
import { ENTRY } from "../shared/protocol.ts";

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
function fakePi(flags: Record<string, string | undefined>, cwd: string) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notices: string[] = [];
  let shutdown = false;
  const pi = {
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.set(event, handler),
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    shutdown: () => (shutdown = true),
    ui: { notify: (message: string) => void notices.push(message) },
  };
  projectContext(pi);
  return {
    entries,
    notices,
    get shutdown() {
      return shutdown;
    },
    emit: (name: string, event: object = {}) => handlers.get(name)?.({ type: name, ...event }, ctx),
    command: (name: string) => commands.get(name)!.handler("", ctx),
  };
}

async function tmp(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-projext-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

/** Runs before_agent_start with pi's existing sections and returns them afterwards. */
function promptSections(pi: ReturnType<typeof fakePi>, existing: Record<string, string> = { cwd: "/w" }) {
  const systemPromptOptions = { sections: { ...existing } };
  pi.emit("before_agent_start", { prompt: "go", systemPrompt: "", systemPromptOptions });
  return systemPromptOptions.sections;
}

test("adds the project sections after pi's own, the same on every prompt", async () => {
  const project = await tmp({ "project.yaml": "version: 1\nname: demo\nrules: [Be careful.]\n" });
  const workspace = await tmp({ "AGENTS.md": "Use pnpm.\n" });
  const pi = fakePi({ project }, workspace);
  await pi.emit("session_start");

  const first = promptSections(pi);
  assert.deepEqual(Object.keys(first), ["cwd", "project", "project_rules", "agents_md"]);
  assert.equal(first.project, "name: demo");
  assert.equal(first.agents_md, `path: ${join(workspace, "AGENTS.md")}\nUse pnpm.`);

  // Read once per session: later file changes don't reach this session's prompt.
  await writeFile(join(workspace, "AGENTS.md"), "Changed.\n");
  assert.deepEqual(promptSections(pi), first);

  await pi.command("project");
  assert.match(pi.notices[0], /^Project: demo \(.*\)\n  <project>  ~\d+ tokens\n/);
  assert.match(pi.notices[0], /Block B total: ~\d+ tokens$/);
});

test("without --project or AGENTS.md it adds nothing", async () => {
  const pi = fakePi({}, await tmp({}));
  await pi.emit("session_start");
  assert.deepEqual(promptSections(pi), { cwd: "/w" });
  await pi.command("project");
  assert.match(pi.notices[0], /^No project context/);
});

test("a relative --project resolves against the cwd", async () => {
  const workspace = await tmp({ "project.yaml": "version: 1\nname: here\n" });
  const pi = fakePi({ project: "." }, workspace);
  await pi.emit("session_start");
  assert.equal(promptSections(pi).project, "name: here");
});

test("invalid manifest: records an error entry and shuts down", async () => {
  const pi = fakePi({ project: await tmp({ "project.yaml": "version: 1\n" }) }, await tmp({}));
  await pi.emit("session_start");
  assert.equal(pi.shutdown, true);
  assert.equal(pi.entries[0].customType, ENTRY.error);
  assert.match((pi.entries[0].data as { message: string }).message, /Invalid .*project\.yaml/);
});
