import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import projectContext from "./index.ts";
import { ENTRY } from "../shared/protocol.ts";

type ContextFile = { path: string; content: string };

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
function fakePi(flags: Record<string, string | undefined>, cwd: string, piContextFiles: ContextFile[] = []) {
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
    getSystemPromptOptions: () => ({ cwd, contextFiles: piContextFiles }),
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

/** Runs before_agent_start with pi's existing prompt options and returns them afterwards. */
function promptOptions(pi: ReturnType<typeof fakePi>, contextFiles: ContextFile[] = []) {
  const systemPromptOptions = { sections: { cwd: "/w" } as Record<string, string>, contextFiles: [...contextFiles] };
  pi.emit("before_agent_start", { prompt: "go", systemPrompt: "", systemPromptOptions });
  return systemPromptOptions;
}

const promptSections = (pi: ReturnType<typeof fakePi>) => promptOptions(pi).sections;

const PI_AGENTS_MD: ContextFile = { path: "/w/AGENTS.md", content: "From pi." };

/** A minimal Anthropic payload whose system prompt contains `text`, with a cache marker. */
const payload = (text: string) => ({ system: [{ type: "text", text, cache_control: { type: "ephemeral" } }] });

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
  assert.match(pi.notices[0], /^Project: demo \(.*\); pi's context files are off\n  <project>  ~\d+ tokens\n/);
  assert.match(pi.notices[0], /Block B total: ~\d+ tokens$/);
});

test("without --project or AGENTS.md it adds nothing", async () => {
  const pi = fakePi({}, await tmp({}));
  await pi.emit("session_start");
  assert.deepEqual(promptSections(pi), { cwd: "/w" });
  await pi.command("project");
  assert.match(pi.notices[0], /^No project context/);
});

test("with --project, pi's context files are dropped (as with -nc)", async () => {
  const project = await tmp({ "project.yaml": "version: 1\nname: demo\n" });
  const workspace = await tmp({ "AGENTS.md": "Use pnpm.\n" });
  const piFiles = [{ path: "/home/AGENTS.md", content: "Global." }, PI_AGENTS_MD];
  const pi = fakePi({ project }, workspace, piFiles);
  await pi.emit("session_start");
  const options = promptOptions(pi, piFiles);
  assert.deepEqual(options.contextFiles, []);
  assert.deepEqual(Object.keys(options.sections), ["cwd", "project", "agents_md"]);
  await pi.command("project");
  assert.match(pi.notices[0], /pi's context files are off/);
});

test("without --project, pi's own context files win and nothing is added or split", async () => {
  const workspace = await tmp({ "AGENTS.md": "Use pnpm.\n" });
  const pi = fakePi({}, workspace, [PI_AGENTS_MD]);
  await pi.emit("session_start");
  // /project knows before the first prompt.
  await pi.command("project");
  assert.match(pi.notices[0], /^No project context: no --project, pi loads its own context files \(1\)/);
  const options = promptOptions(pi, [PI_AGENTS_MD]);
  assert.deepEqual(options.contextFiles, [PI_AGENTS_MD]);
  assert.deepEqual(options.sections, { cwd: "/w" });
  const request = payload(`prompt\n\n<agents_md>\npath: ${join(workspace, "AGENTS.md")}\nUse pnpm.\n</agents_md>`);
  assert.equal(pi.emit("before_provider_request", { payload: request }), undefined);
});

test("without --project and without pi's context files (-nc), AGENTS.md is block B", async () => {
  const workspace = await tmp({ "AGENTS.md": "Use pnpm.\n" });
  const pi = fakePi({}, workspace);
  await pi.emit("session_start");
  assert.deepEqual(Object.keys(promptSections(pi)), ["cwd", "agents_md"]);
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
