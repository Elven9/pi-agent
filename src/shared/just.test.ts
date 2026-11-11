import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadJustCommands, recipesOf, type JustDump } from "./just.ts";
import { loadProject, loadProjectFrom } from "./project.ts";
import { CliError, type ProjectSource } from "./project-source.ts";

const hasJust = (() => {
  try {
    execFileSync("just", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const needsJust = { skip: hasJust ? false : "just is not installed" };

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-just-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

const MANIFEST = "version: 1\nname: x\n";
/** Runs a listed command (with its recipe and arguments) through the shell, as the agent would, from `cwd`. */
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("JUST_")));
const sh = (cwd: string, command: string) => execFileSync("sh", ["-c", command], { cwd, env, encoding: "utf8" }).trim();
const pwd = (dir: string) => execFileSync("pwd", ["-P"], { cwd: dir, encoding: "utf8" }).trim();

test("recipesOf: public recipes sorted, then submodules; arguments as usage", () => {
  const p = (name: string, kind: string, d: unknown = null, extra = {}) => ({ name, kind, default: d, ...extra });
  const dump = {
    settings: {},
    recipes: {
      zeta: { namepath: "zeta", doc: " Last. ", private: false, parameters: [] },
      _hidden: { namepath: "_hidden", doc: null, private: true, parameters: [] },
      alpha: {
        namepath: "alpha",
        doc: null,
        private: false,
        parameters: [p("a", "singular"), p("b", "singular", "x"), p("c", "plus"), p("v", "singular", "n", { long: "verbose", flag: true })],
      },
      star: { namepath: "star", doc: null, private: false, parameters: [p("rest", "star"), p("o", "singular", null, { long: "out" })] },
    },
    modules: {
      db: { settings: {}, modules: {}, recipes: { up: { namepath: "db::up", doc: "Migrate.", private: false, parameters: [] } } },
    },
  } as unknown as JustDump;
  assert.deepEqual(recipesOf(dump), [
    { name: "alpha", usage: "<a> [<b>] <c>... [--verbose]" },
    { name: "star", usage: "[<rest>]... --out <o>" },
    { name: "zeta", usage: "", doc: "Last." },
    { name: "db::up", usage: "", doc: "Migrate." },
  ]);
});

test("no justfile anywhere: undefined, just is not run", async () => {
  const run = async () => assert.fail("just must not run");
  assert.equal(await loadJustCommands({ cwd: await folder({}), project: await loadProject(await folder({ "project.yaml": MANIFEST })), run }), undefined);
});

test("several justfiles in one folder are an error", async () => {
  await assert.rejects(loadJustCommands({ cwd: await folder({ justfile: "", ".justfile": "" }) }), /has several justfiles/);
});

test("project justfile alone: run with --justfile and --working-directory, in the workspace", needsJust, async () => {
  const projectDir = await folder({
    "project.yaml": MANIFEST,
    justfile: "# Where am I?\nwhere:\n  @pwd -P\n# Its own script.\nhello:\n  @{{justfile_directory()}}/scripts/hello.sh\n",
    "scripts/hello.sh": "#!/bin/sh\necho hello from the project\n",
  });
  await chmod(join(projectDir, "scripts/hello.sh"), 0o755);
  const cwd = await folder({});
  const c = (await loadJustCommands({ cwd, project: await loadProject(projectDir) }))!;
  const justfile = join(projectDir, "justfile");
  assert.equal(c.workdir, cwd);
  assert.deepEqual(c.sources, [
    {
      label: justfile,
      justfile,
      command: `just --justfile ${justfile} --working-directory ${cwd}`,
      recipes: [
        { name: "hello", usage: "", doc: "Its own script." },
        { name: "where", usage: "", doc: "Where am I?" },
      ],
    },
  ]);
  // From any folder: recipes run in the workspace, and justfile_directory() is the project's.
  assert.equal(sh(tmpdir(), `${c.sources[0]!.command} where`), pwd(cwd));
  assert.equal(sh(tmpdir(), `${c.sources[0]!.command} hello`), "hello from the project");
});

test("both justfiles: not merged, each listed and run on its own", needsJust, async () => {
  const projectDir = await folder({
    "project.yaml": MANIFEST,
    // Settings that differ from the workspace's are fine: the files are never combined.
    justfile: 'set shell := ["bash", "-c"]\n# Project test.\ntest:\n  @echo project\n# Lint.\nlint *files:\n  @echo lint {{files}}\n',
  });
  const cwd = await folder({ Justfile: 'set shell := ["sh", "-c"]\n# Workspace test.\ntest:\n  @echo workspace {{justfile_directory()}}\n' });
  const c = (await loadJustCommands({ cwd, project: await loadProject(projectDir) }))!;
  const [ws, proj] = c.sources;
  assert.deepEqual([ws!.label, proj!.label], [join(cwd, "Justfile"), join(projectDir, "justfile")]);
  assert.equal(ws!.command, "just");
  assert.deepEqual(ws!.recipes, [{ name: "test", usage: "", doc: "Workspace test." }]);
  assert.deepEqual(proj!.recipes, [
    { name: "lint", usage: "[<files>]...", doc: "Lint." },
    { name: "test", usage: "", doc: "Project test." },
  ]);
  assert.equal(sh(cwd, `${ws!.command} test`), `workspace ${pwd(cwd)}`);
  assert.equal(sh(cwd, `${proj!.command} test`), "project");
  assert.equal(sh(cwd, `${proj!.command} lint a`), "lint a");
});

test("paths with spaces are quoted in the command", needsJust, async () => {
  const projectDir = join(await folder({}), "my project");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "project.yaml"), MANIFEST);
  await writeFile(join(projectDir, "justfile"), "where:\n  @pwd -P\n");
  const cwd = join(await folder({}), "it's here");
  await mkdir(cwd);
  const c = (await loadJustCommands({ cwd, project: await loadProject(projectDir) }))!;
  assert.equal(c.sources[0]!.command, `just --justfile '${join(projectDir, "justfile")}' --working-directory '${cwd.replace("'", "'\\''")}'`);
  assert.equal(sh(tmpdir(), `${c.sources[0]!.command} where`), pwd(cwd));
});

test("the project folder as the workspace: its justfile counts once, run with a plain just", needsJust, async () => {
  const dir = await folder({ "project.yaml": MANIFEST, justfile: "a:\n" });
  const c = (await loadJustCommands({ cwd: dir, project: await loadProject(dir) }))!;
  assert.deepEqual(c.sources.map((s) => [s.label, s.command]), [[join(dir, "justfile"), "just"]]);
});

test("an invalid justfile names the file", needsJust, async () => {
  const projectDir = await folder({ "project.yaml": MANIFEST, justfile: "a:\n" });
  await assert.rejects(
    loadJustCommands({ cwd: await folder({ justfile: "oops" }), project: await loadProject(projectDir) }),
    /Cannot read .*justfile/,
  );
});

test("remote project: its justfile is written to a fixed path named after the source", needsJust, async () => {
  const files: Record<string, string> = { "project.yaml": MANIFEST, justfile: "# Hi.\nhi:\n  @echo hi\n" };
  const source: ProjectSource = { kind: "remote", label: "https://github.com/o/r@v1", read: async (p: string) => files[p] } as ProjectSource;
  const cwd = await folder({});
  const c = (await loadJustCommands({ cwd, project: await loadProjectFrom(source) }))!;
  const justfile = join(tmpdir(), "pi-agent-just", "github.com_o_r@v1", "justfile");
  assert.deepEqual(c.sources.map((s) => [s.label, s.justfile]), [["justfile in https://github.com/o/r@v1", justfile]]);
  assert.equal(await readFile(justfile, "utf8"), files.justfile);
  assert.equal(sh(cwd, `${c.sources[0]!.command} hi`), "hi");
  // Same source, same path: the prompt doesn't change between runs.
  const again = (await loadJustCommands({ cwd, project: await loadProjectFrom(source) }))!;
  assert.equal(again.sources[0]!.command, c.sources[0]!.command);
});

test("just not installed: no commands, a warning naming the justfiles", async () => {
  const run = async () => {
    throw new CliError("just is not installed (or not on PATH)", "", true);
  };
  const cwd = await folder({ justfile: "a:\n" });
  const warnings: string[] = [];
  assert.equal(await loadJustCommands({ cwd, run, warn: (w) => warnings.push(w) }), undefined);
  assert.deepEqual(warnings, [`just is not installed (or not on PATH): skipped the commands from ${join(cwd, "justfile")}`]);
});

test("just failing for another reason is still an error", async () => {
  const run = async () => {
    throw new CliError("just --dump failed: boom", "boom");
  };
  await assert.rejects(loadJustCommands({ cwd: await folder({ justfile: "a:\n" }), run, warn: () => assert.fail("no warning") }), /Cannot read .*justfile: just --dump failed/);
});
