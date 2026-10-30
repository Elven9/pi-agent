import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { justEnv, loadJustCommands, recipesOf, type JustDump } from "./just.ts";
import { loadProject, loadProjectFrom } from "./project.ts";
import type { ProjectSource } from "./project-source.ts";

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
const just = (env: Record<string, string>, ...args: string[]) =>
  execFileSync("just", args, { env: { ...process.env, ...env }, cwd: tmpdir(), encoding: "utf8" });

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

test("project justfile alone: used as is; recipes run in the workspace", needsJust, async () => {
  const projectDir = await folder({ "project.yaml": MANIFEST, justfile: "# Where am I?\nwhere:\n  @pwd\n" });
  const cwd = await folder({});
  const c = (await loadJustCommands({ cwd, project: await loadProject(projectDir) }))!;
  assert.deepEqual(c.sources, [join(projectDir, "justfile")]);
  assert.equal(c.justfile, join(projectDir, "justfile"));
  assert.deepEqual(c.recipes, [{ name: "where", usage: "", doc: "Where am I?" }]);
  assert.equal(just(justEnv(c), "where").trim(), execFileSync("pwd", { cwd, encoding: "utf8" }).trim());
});

test("both justfiles: merged, the workspace's recipe wins a clash", needsJust, async () => {
  const projectDir = await folder({
    "project.yaml": MANIFEST,
    justfile: "# Project test.\ntest:\n  @echo project\n# Lint.\nlint *files:\n  @echo lint {{files}}\n",
  });
  const cwd = await folder({ Justfile: "# Workspace test.\ntest:\n  @echo workspace\n" });
  const c = (await loadJustCommands({ cwd, project: await loadProject(projectDir) }))!;
  assert.deepEqual(c.sources, [join(cwd, "Justfile"), join(projectDir, "justfile")]);
  assert.deepEqual(c.recipes, [
    { name: "lint", usage: "[<files>]...", doc: "Lint." },
    { name: "test", usage: "", doc: "Workspace test." },
  ]);
  assert.match(await readFile(c.justfile, "utf8"), /^set allow-duplicate-recipes$/m);
  assert.equal(just(justEnv(c), "test", "lint", "a").trim(), "workspace\nlint a");
});

test("both justfiles already allowing duplicates: not set twice", needsJust, async () => {
  const projectDir = await folder({ "project.yaml": MANIFEST, justfile: "set allow-duplicate-recipes\nt:\n  @echo p\n" });
  const cwd = await folder({ justfile: "t:\n  @echo w\n" });
  const c = (await loadJustCommands({ cwd, project: await loadProject(projectDir) }))!;
  assert.doesNotMatch(await readFile(c.justfile, "utf8"), /^set /m);
  assert.equal(just(justEnv(c), "t").trim(), "w");
});

test("the project folder as the workspace: its justfile counts once", needsJust, async () => {
  const dir = await folder({ "project.yaml": MANIFEST, justfile: "a:\n" });
  const c = (await loadJustCommands({ cwd: dir, project: await loadProject(dir) }))!;
  assert.deepEqual(c.sources, [join(dir, "justfile")]);
});

test("invalid or unmergeable justfiles name the file", needsJust, async () => {
  const projectDir = await folder({ "project.yaml": MANIFEST, justfile: "set shell := [\"bash\", \"-c\"]\na:\n" });
  await assert.rejects(
    loadJustCommands({ cwd: await folder({ justfile: "oops" }), project: await loadProject(projectDir) }),
    /Cannot read .*justfile/,
  );
  await assert.rejects(
    loadJustCommands({ cwd: await folder({ justfile: "set shell := [\"sh\", \"-c\"]\nb:\n" }), project: await loadProject(projectDir) }),
    /Cannot merge .*justfile and .*justfile: .*shell/s,
  );
});

test("remote project: its justfile is copied to the temp folder and labelled by the source", needsJust, async () => {
  const files: Record<string, string> = { "project.yaml": MANIFEST, justfile: "# Hi.\nhi:\n  @echo hi\n" };
  const source: ProjectSource = { kind: "remote", label: "https://github.com/o/r@v1", read: async (p: string) => files[p] } as ProjectSource;
  const c = (await loadJustCommands({ cwd: await folder({}), project: await loadProjectFrom(source) }))!;
  assert.deepEqual(c.sources, ["justfile in https://github.com/o/r@v1"]);
  assert.equal(await readFile(c.justfile, "utf8"), files.justfile);
  assert.equal(just(justEnv(c), "hi").trim(), "hi");
});

test("just not installed: a clear error", async () => {
  const run = async () => {
    throw new Error("just is not installed (or not on PATH)");
  };
  await assert.rejects(loadJustCommands({ cwd: await folder({ justfile: "a:\n" }), run }), /Cannot read .*justfile: just is not installed/);
});
