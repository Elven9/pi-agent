import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorktree, formatList, parseCommand, rebasePath, SECTION, TOOL, type WorktreeEntry } from "./index.ts";
import { ENTRY, PROJECT_CHANNEL, type ProjectAnnounced } from "../shared/protocol.ts";

const exists = (p: string) => stat(p).then(() => true, () => false);
const tmp = async () => realpath(await mkdtemp(join(tmpdir(), "pi-agent-wtext-")));

async function makeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  g("init", "-q", "-b", "master");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

type Entry = { type: "custom"; customType: string; data: unknown };

/** Minimal ExtensionAPI: entries appended go into the session branch the next start reads. */
function fakePi(cwd: string, o: { settings?: object; entries?: Entry[]; hasUI?: boolean; tempDir?: string } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: Entry[] = [...(o.entries ?? [])];
  const notices: Array<[string, string]> = [];
  let shutdown = false;
  const pi = {
    events: {
      on: (channel: string, fn: (data: unknown) => void) => void listeners.set(channel, [...(listeners.get(channel) ?? []), fn]),
      emit: (channel: string, data: unknown) => listeners.get(channel)?.forEach((fn) => fn(data)),
    },
    on: (event: string, handler: any) => void handlers.set(event, handler),
    registerTool: (tool: any) => void tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data }),
    getSettings: () => o.settings ?? {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: o.hasUI ?? true,
    shutdown: () => (shutdown = true),
    sessionManager: { getBranch: () => [...entries] },
    ui: { notify: (message: string, level: string) => void notices.push([message, level]) },
  };
  // The test repositories are in the OS temp folder, so a separate one stands in for it.
  createWorktree({ tempDir: o.tempDir ?? "/nonexistent-temp" })(pi);
  return {
    entries,
    notices,
    get shutdown() {
      return shutdown;
    },
    announce: (data: ProjectAnnounced) => pi.events.emit(PROJECT_CHANNEL, data),
    start: () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
    tool: async (name: string, params: object) => (await tools.get(name).execute("id", params, undefined, undefined, ctx)).content[0].text as string,
    command: (args: string) => commands.get("worktree").handler(args, ctx),
    /** Runs tool_call on a copy of `input`; returns the (mutated) input and the handler's result. */
    async call(toolName: string, input: Record<string, unknown>) {
      const event = { toolName, input: { ...input } };
      const result = await handlers.get("tool_call")!(event, ctx);
      return { input: event.input, result };
    },
    sections() {
      const systemPromptOptions = { sections: {} as Record<string, string> };
      handlers.get("before_agent_start")!({ systemPromptOptions }, ctx);
      return systemPromptOptions.sections;
    },
    worktreeEntries: () => entries.filter((e) => e.customType === ENTRY.worktree).map((e) => e.data as WorktreeEntry),
  };
}

test("worktree_add: in .pi/worktree of the cwd by default, /.pi/ excluded, settings copied; enter: true enters it", async () => {
  const repo = await makeRepo(join(await tmp(), "app"));
  await mkdir(join(repo, ".pi"));
  await writeFile(join(repo, ".pi", "settings.json"), JSON.stringify({ project: { type: "local", dir: "/p" } }));
  const pi = fakePi(repo);
  await pi.start();

  const text = await pi.tool(TOOL.add, { branch: "feat/x", enter: true });
  const path = join(repo, ".pi", "worktree", "app-wt", "feat-x");
  assert.match(text, new RegExp(`Worktree ${path}: created feat/x from HEAD`));
  assert.match(text, /Copied .*settings\.json/);
  assert.match(text, /Entered it/);
  assert.ok(await exists(join(path, ".pi", "settings.json")));
  assert.match(await readFile(join(repo, ".git", "info", "exclude"), "utf8"), /^\/\.pi\/$/m);
  // The worktree folder inside the repo is ignored too.
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), "");
  assert.deepEqual(pi.worktreeEntries(), [{ version: 1, worktree: { path, repo, branch: "feat/x" } }]);
});

test("folder: project.worktreeDir, then worktree.dir, then .pi/worktree in the project folder", async () => {
  const root = await tmp();
  const repo = await makeRepo(join(root, "app"));
  const folder = join(root, "proj");

  const both = fakePi(repo, { settings: { worktree: { dir: join(root, "global") } } });
  both.announce({ block: "", folder, worktreeDir: join(root, "fromProject") });
  await both.start();
  assert.match(await both.tool(TOOL.add, { branch: "a" }), new RegExp(`Worktree ${join(root, "fromProject", "app-wt", "a")}:`));

  const global = fakePi(repo, { settings: { worktree: { dir: join(root, "global") } } });
  global.announce({ block: "", folder });
  await global.start();
  assert.match(await global.tool(TOOL.add, { branch: "b" }), new RegExp(`Worktree ${join(root, "global", "app-wt", "b")}:`));

  const project = fakePi(repo);
  project.announce({ block: "", folder });
  await project.start();
  assert.match(await project.tool(TOOL.add, { branch: "c" }), new RegExp(`Worktree ${join(folder, ".pi", "worktree", "app-wt", "c")}:`));
});

test("while entered: paths and bash run in the worktree, write/edit outside it are blocked, the prompt says so", async () => {
  const repo = await makeRepo(join(await tmp(), "app"));
  const temp = await tmp();
  const pi = fakePi(repo, { tempDir: temp });
  await pi.start();
  assert.deepEqual((await pi.call("read", { path: "a.txt" })).input, { path: "a.txt" }); // not entered: unchanged
  assert.deepEqual(pi.sections(), {});

  await pi.tool(TOOL.add, { branch: "feat/x" });
  const wt = join(repo, ".pi", "worktree", "app-wt", "feat-x");
  assert.match(await pi.tool(TOOL.enter, { branch: "feat/x" }), /Entered worktree/);

  assert.deepEqual((await pi.call("read", { path: "src/a.ts" })).input, { path: join(wt, "src/a.ts") });
  assert.deepEqual((await pi.call("read", { path: "/etc/hosts" })).input, { path: "/etc/hosts" });
  assert.deepEqual((await pi.call("ls", {})).input, { path: wt });
  assert.deepEqual((await pi.call("grep", { pattern: "x" })).input, { pattern: "x", path: wt });
  assert.equal((await pi.call("bash", { command: "pwd" })).input.command, `cd '${wt}' || exit 1\npwd`);

  assert.equal((await pi.call("write", { path: "new.txt", content: "" })).result, undefined);
  assert.equal((await pi.call("edit", { path: join(temp, "x.txt"), edits: [] })).result, undefined);
  const blocked = (await pi.call("write", { path: join(repo, "a.txt"), content: "" })).result;
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /outside the worktree .*\(\/worktree exit\)/);
  assert.equal((await pi.call("edit", { path: "../../../../a.txt", edits: [] })).result.block, true);

  assert.match(pi.sections()[SECTION]!, new RegExp(`git worktree ${wt} \\(repository ${repo}, branch feat/x\\), not in ${repo}`));
});

test("list: * on the entered worktree, else on the checkout of the cwd", async () => {
  const root = await makeRepo(await tmp());
  const sub = await makeRepo(join(root, "sub"));
  const pi = fakePi(root);
  await pi.start();
  await pi.tool(TOOL.add, { repo: "sub", branch: "feat/x" });
  const wt = join(root, ".pi", "worktree", "sub-wt", "feat-x");

  const before = await pi.tool(TOOL.list, {});
  assert.match(before, new RegExp(`^\\* ${root}  \\[master\\]$`, "m"));
  assert.match(before, new RegExp(`^  ${sub}  \\[master\\]$`, "m"));
  assert.match(before, new RegExp(`^  ${wt}  \\[feat/x\\]$`, "m"));

  await pi.command("enter feat/x --repo sub");
  const after = await pi.tool(TOOL.list, {});
  assert.match(after, new RegExp(`^  ${root}  \\[master\\]$`, "m"));
  assert.match(after, new RegExp(`^\\* ${wt}  \\[feat/x\\]$`, "m"));
  assert.equal(after.split("\n").filter((l) => l.startsWith("*")).length, 1);
});

test("remove: refused for the entered worktree and the main checkout; after /worktree exit it works and keeps the branch", async () => {
  const repo = await makeRepo(join(await tmp(), "app"));
  const pi = fakePi(repo);
  await pi.start();
  await pi.tool(TOOL.add, { branch: "feat/x", enter: true });
  await assert.rejects(pi.tool(TOOL.remove, { branch: "feat/x" }), /session is in .*\/worktree exit/);
  await assert.rejects(pi.tool(TOOL.remove, { branch: "master" }), /is the main checkout/);

  await pi.command("exit");
  assert.match(pi.notices.at(-1)![0], /^Left worktree/);
  assert.deepEqual(pi.worktreeEntries().at(-1), { version: 1 });
  assert.deepEqual((await pi.call("read", { path: "a" })).input, { path: "a" });

  assert.match(await pi.tool(TOOL.remove, { branch: "feat/x" }), /branch feat\/x is kept/);
  assert.ok(!(await exists(join(repo, ".pi", "worktree", "app-wt"))));
  execFileSync("git", ["-C", repo, "show-ref", "--verify", "refs/heads/feat/x"]);
});

test("session start restores the entered worktree; a deleted one is left with a warning", async () => {
  const repo = await makeRepo(join(await tmp(), "app"));
  const first = fakePi(repo);
  await first.start();
  await first.tool(TOOL.add, { branch: "feat/x", enter: true });

  const resumed = fakePi(repo, { entries: first.entries });
  await resumed.start();
  assert.ok(resumed.sections()[SECTION]);

  await rm(join(repo, ".pi", "worktree"), { recursive: true });
  const gone = fakePi(repo, { entries: first.entries });
  await gone.start();
  assert.deepEqual(gone.sections(), {});
  assert.match(gone.notices.at(-1)![0], /no longer exists/);
  assert.deepEqual(gone.worktreeEntries().at(-1), { version: 1 });
});

test("an invalid worktree setting is an error entry and shuts down", async () => {
  const pi = fakePi(await tmp(), { settings: { worktree: { dir: 1 } } });
  await pi.start();
  assert.ok(pi.shutdown);
  assert.match((pi.entries.find((e) => e.customType === ENTRY.error)!.data as { message: string }).message, /Invalid "worktree"/);
});

test("errors: not a repository, unknown branch", async () => {
  const dir = await tmp();
  const pi = fakePi(dir);
  await pi.start();
  await assert.rejects(pi.tool(TOOL.add, { branch: "x" }), /is not in a git repository; pass repo/);
  const repo = await makeRepo(join(dir, "r"));
  await assert.rejects(pi.tool(TOOL.enter, { repo, branch: "nope" }), /r has no worktree for branch nope/);
  await pi.command("bogus");
  assert.match(pi.notices.at(-1)![0], /Unknown subcommand "bogus"\n\/worktree list/);
});

test("parseCommand and rebasePath", () => {
  assert.deepEqual(parseCommand(""), { sub: "list" });
  assert.deepEqual(parseCommand("add feat/x --repo a --base dev --enter"), { sub: "add", branch: "feat/x", repo: "a", base: "dev", enter: true });
  assert.deepEqual(parseCommand("remove feat/x"), { sub: "remove", branch: "feat/x" });
  assert.throws(() => parseCommand("enter"), /exactly one branch/);
  assert.throws(() => parseCommand("enter x --base y"), /Unknown option --base/);
  assert.throws(() => parseCommand("add x --repo"), /--repo needs a value/);
  assert.throws(() => parseCommand("exit now"), /takes no arguments/);
  assert.equal(rebasePath("a/b", "/w"), "/w/a/b");
  assert.equal(rebasePath("@a", "/w"), "/w/a");
  assert.equal(rebasePath("@/abs", "/w"), "@/abs");
  assert.equal(rebasePath("~/x", "/w"), "~/x");
  assert.equal(formatList([], undefined), "No git repositories in the workspace.");
});
