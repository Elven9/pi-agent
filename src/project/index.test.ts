import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import projectContext, { createProjectContext } from "./index.ts";
import { ENTRY, PROJECT_CHANNEL, PROJECT_READ } from "../shared/protocol.ts";
import { CliError, type CliRunner } from "../shared/project-source.ts";

type ContextFile = { path: string; content: string };

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
function fakePi(
  flags: Record<string, string | undefined>,
  cwd: string,
  piContextFiles: ContextFile[] = [],
  o: { settings?: object; run?: CliRunner; active?: string[] } = {},
) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const tools = new Map<string, { exposure?: string; execute: (...args: any[]) => Promise<any> }>();
  let active = o.active ?? ["read", "bash"];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notices: string[] = [];
  const announced: unknown[] = [];
  let shutdown = false;
  const pi = {
    events: { emit: (channel: string, data: unknown) => void (channel === PROJECT_CHANNEL && announced.push(data)) },
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.set(event, handler),
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
    registerTool: (tool: { name: string; exposure?: string; execute: (...args: any[]) => Promise<any> }) => void tools.set(tool.name, tool),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => void (active = [...names]),
    getSettings: () => o.settings ?? {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    shutdown: () => (shutdown = true),
    getSystemPromptOptions: () => ({ cwd, contextFiles: piContextFiles }),
    ui: { notify: (message: string) => void notices.push(message) },
  };
  (o.run ? createProjectContext({ run: o.run }) : projectContext)(pi);
  return {
    get active() {
      return active;
    },
    tool: (name: string, params: object) => tools.get(name)!.execute("id", params, undefined, undefined, ctx),
    exposure: (name: string) => tools.get(name)?.exposure,
    entries,
    notices,
    announced,
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

  // Announced for /context: at session start (not applied yet), then on each prompt.
  assert.deepEqual(pi.announced[0], { project: { name: "demo", dir: project }, block: "" });
  assert.match((pi.announced.at(-1) as { block: string }).block, /^<project>\nname: demo\n<\/project>\n\n<project_rules>/);

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
  assert.match(pi.notices[0], /^No project context: no project, pi loads its own context files \(1\)/);
  const options = promptOptions(pi, [PI_AGENTS_MD]);
  assert.deepEqual(pi.announced.at(-1), { project: undefined, block: "" });
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


// --- Remote project (settings.json "project") ---

const b64 = (s: string) => Buffer.from(s).toString("base64");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Fake gh for one GitHub repo at one tag: file path → content. Records the calls. */
function fakeGh(files: Record<string, string>, calls: string[][] = []): CliRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    const endpoint = args[3];
    if (endpoint === "repos/acme/proj/commits/refs/tags/v1.0.0") return `${COMMIT}\n`;
    const m = /^repos\/acme\/proj\/contents\/(.+)\?ref=(\w+)$/.exec(endpoint);
    if (m && m[2] === COMMIT && decodeURIComponent(m[1]) in files) {
      return JSON.stringify({ type: "file", encoding: "base64", content: b64(files[decodeURIComponent(m[1])]) });
    }
    throw new CliError(`gh failed`, "gh: Not Found (HTTP 404)");
  };
}

const SETTINGS = { project: { repo: "https://github.com/acme/proj", provider: "github", tag: "v1.0.0" } };
const REMOTE_FILES = {
  "project.yaml": "version: 1\nname: remote-demo\ndocs:\n  - path: docs/a.md\n    when: Always.\n",
  "docs/a.md": "line 1\nline 2\nline 3\n",
};

test("settings.json project: loads project.yaml from the repo without --project", async () => {
  const calls: string[][] = [];
  const pi = fakePi({}, await tmp({}), [], { settings: SETTINGS, run: fakeGh(REMOTE_FILES, calls) });
  assert.equal(pi.exposure(PROJECT_READ), "hidden");
  await pi.emit("session_start");
  assert.equal(pi.shutdown, false);
  // Declared to the model and callable from codemode scripts (also with codemode.mode "only").
  assert.equal(pi.exposure(PROJECT_READ), "codemode");
  const sections = promptSections(pi);
  assert.equal(sections.project, "name: remote-demo");
  assert.equal(
    sections.project_docs,
    "Read every doc whose condition applies with the project_read tool; a task can need several docs on different topics:\n- docs/a.md: Always.",
  );
  assert.ok(pi.active.includes(PROJECT_READ));
  assert.deepEqual(pi.announced[0], { project: { name: "remote-demo", dir: "https://github.com/acme/proj@v1.0.0" }, block: "" });
  await pi.command("project");
  assert.match(pi.notices[0], /^Project: remote-demo \(https:\/\/github\.com\/acme\/proj@v1\.0\.0 = 0123456789ab\)/);

  // project_read: served from the cache filled by validation (docs/a.md was read once).
  const result = await pi.tool(PROJECT_READ, { path: "./docs/a.md" });
  assert.equal(result.content[0].text, "line 1\nline 2\nline 3\n");
  assert.deepEqual(result.details, { path: "docs/a.md", commit: COMMIT });
  assert.equal(calls.filter((c) => c[4].includes("docs/a.md")).length, 1);
  const page = await pi.tool(PROJECT_READ, { path: "docs/a.md", offset: 2, limit: 1 });
  assert.equal(page.content[0].text, "line 2\n\n[2 more lines. Use offset=3 to continue.]");
  await assert.rejects(pi.tool(PROJECT_READ, { path: "../secret" }), /not a path inside the project/);
  await assert.rejects(pi.tool(PROJECT_READ, { path: "nope.md" }), /no such file in the project/);
});

test("--project wins over settings.json project (not even read)", async () => {
  const project = await tmp({ "project.yaml": "version: 1\nname: local\n" });
  const run: CliRunner = async () => assert.fail("gh must not run");
  const pi = fakePi({ project }, await tmp({}), [], { settings: { project: { bogus: true } }, run, active: ["read", PROJECT_READ] });
  await pi.emit("session_start");
  assert.equal(promptSections(pi).project, "name: local");
  assert.ok(!pi.active.includes(PROJECT_READ));
  assert.equal(pi.exposure(PROJECT_READ), "hidden");
  await assert.rejects(pi.tool(PROJECT_READ, { path: "x" }), /no remote project/);
});

test("invalid settings.json project or a missing tag: error entry and shutdown", async () => {
  const bad = fakePi({}, await tmp({}), [], { settings: { project: { repo: "x", provider: "github" } }, run: fakeGh({}) });
  await bad.emit("session_start");
  assert.equal(bad.shutdown, true);
  assert.match((bad.entries[0].data as { message: string }).message, /Invalid "project" in settings\.json:\n\/ must have required properties tag/);

  const settings = { project: { ...SETTINGS.project, tag: "v9" } };
  const missing = fakePi({}, await tmp({}), [], { settings, run: fakeGh(REMOTE_FILES) });
  await missing.emit("session_start");
  assert.equal(missing.shutdown, true);
  assert.match((missing.entries[0].data as { message: string }).message, /Cannot open project https:\/\/github\.com\/acme\/proj@v9 with gh .*tag v9 not found/);
});

