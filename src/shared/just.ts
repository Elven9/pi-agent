import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCli, type CliRunner } from "./project-source.ts";
import type { Project } from "./project.ts";

/**
 * Project commands as `just` recipes (README "Project commands"). The commands section of block B
 * lists the recipes of the workspace's justfile (in the cwd) and the project's justfile, merged
 * into one: the agent runs `just <recipe>` instead of retyping commands from the prompt.
 *
 * With both justfiles, a generated root justfile imports the two, the workspace's first: on a
 * name clash the workspace recipe wins (just keeps the earlier of two imports at the same depth).
 * The extension points `just` at the result through `JUST_JUSTFILE` and runs every recipe in the
 * workspace through `JUST_WORKING_DIRECTORY` (see `justEnv`); pi's bash tool inherits both.
 *
 * Nothing in the rendered text depends on where the generated file is written, so block B stays
 * byte-identical between runs.
 */

/** File name of a remote project's justfile (a local folder may use any name `just` accepts). */
export const PROJECT_JUSTFILE = "justfile";

export interface JustRecipe {
  /** Module path, e.g. `test` or `db::migrate`. */
  name: string;
  /** Arguments, e.g. `<file> [mode] [args]...`; empty when there are none. */
  usage: string;
  /** The recipe's doc comment, if any. */
  doc?: string;
}

export interface JustCommands {
  /** The source justfiles, for the prompt: workspace first, then the project's. */
  sources: string[];
  /** The justfile to run: the only source, or the generated one that imports both. */
  justfile: string;
  /** Recipes run here (the workspace). */
  workdir: string;
  /** Public recipes, sorted by name, then those of submodules. */
  recipes: JustRecipe[];
}

/** Environment that makes a plain `just` use these commands, from any folder. */
export function justEnv(c: JustCommands): Record<string, string> {
  return { JUST_JUSTFILE: c.justfile, JUST_WORKING_DIRECTORY: c.workdir };
}

/** The justfile in a local folder: any name `just` itself looks for. Several are an error. */
async function findJustfile(dir: string): Promise<string | undefined> {
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && /^\.?justfile$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  if (names.length > 1) throw new Error(`${dir} has several justfiles (${names.join(", ")}); keep one`);
  return names[0] && join(dir, names[0]);
}

/** Generated files go under the temp folder, named by their content. */
async function writeGenerated(name: string, content: string): Promise<string> {
  const dir = join(tmpdir(), "pi-agent-just", createHash("sha256").update(content).digest("hex").slice(0, 16));
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

/** The subset of `just --dump --dump-format json` used here. */
interface DumpParameter {
  name: string;
  kind: "singular" | "plus" | "star";
  default: unknown;
  flag?: boolean;
  long?: string | null;
  short?: string | null;
}
interface DumpRecipe {
  namepath: string;
  doc: string | null;
  private: boolean;
  parameters: DumpParameter[];
}
export interface JustDump {
  recipes: Record<string, DumpRecipe>;
  modules: Record<string, JustDump>;
  settings: { allow_duplicate_recipes?: boolean };
}

async function dump(run: CliRunner, justfile: string): Promise<JustDump> {
  const out = await run("just", ["--justfile", justfile, "--dump", "--dump-format", "json"]).catch((err: Error) => {
    throw new Error(`Cannot read ${justfile}: ${err.message}`);
  });
  return JSON.parse(out) as JustDump;
}

/** One argument as shown to the agent: `<required>`, `[optional]`, `...` for variadic. */
function argument(p: DumpParameter): string {
  const optional = p.default !== null && p.default !== undefined;
  const option = p.long ? `--${p.long}` : p.short ? `-${p.short}` : undefined;
  if (option && p.flag) return `[${option}]`;
  const value = `<${p.name}>`;
  const text = option ? `${option} ${value}` : value;
  if (p.kind === "star") return `[${text}]...`;
  if (p.kind === "plus") return optional ? `[${text}]...` : `${text}...`;
  return optional ? `[${text}]` : text;
}

/** Public recipes of a dump, then those of its submodules, recursively. */
export function recipesOf(d: JustDump): JustRecipe[] {
  const own = Object.values(d.recipes)
    .filter((r) => !r.private)
    .map((r) => ({
      name: r.namepath,
      usage: r.parameters.map(argument).join(" "),
      ...(r.doc?.trim() && { doc: r.doc.trim() }),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const modules = Object.keys(d.modules)
    .sort()
    .flatMap((name) => recipesOf(d.modules[name]!));
  return [...own, ...modules];
}

/** A path as a just string literal (double quotes, escaped). */
const literal = (path: string) => JSON.stringify(path);

/**
 * Finds the workspace's and the project's justfiles and loads their recipes. Undefined when
 * neither has one. Throws when a justfile is invalid, the two cannot be merged, or `just` is
 * not installed. A remote project's justfile is copied to the temp folder (it must be
 * self-contained: its imports and modules are not fetched).
 */
export async function loadJustCommands(o: { cwd: string; project?: Project; run?: CliRunner }): Promise<JustCommands | undefined> {
  const run = o.run ?? execCli;
  const workspace = await findJustfile(o.cwd);
  let project: { path: string; label: string } | undefined;
  const source = o.project?.source;
  if (source?.dir !== undefined) {
    const path = await findJustfile(source.dir);
    if (path && path !== workspace) project = { path, label: path };
  } else if (source) {
    const content = await source.read(PROJECT_JUSTFILE);
    if (content !== undefined) {
      project = { path: await writeGenerated(PROJECT_JUSTFILE, content), label: `${PROJECT_JUSTFILE} in ${source.label}` };
    }
  }
  const files = [...(workspace ? [{ path: workspace, label: workspace }] : []), ...(project ? [project] : [])];
  if (files.length === 0) return undefined;

  // Each on its own first: errors then name the file at fault.
  const dumps = await Promise.all(files.map((f) => dump(run, f.path)));
  let justfile = files[0]!.path;
  let merged = dumps[0]!;
  if (files.length === 2) {
    const names = dumps.map((d) => new Set(Object.keys(d.recipes)));
    const clash = [...names[0]!].some((n) => names[1]!.has(n));
    // Setting it twice in one module is an error, so only when neither file does.
    const allow = clash && !dumps.some((d) => d.settings.allow_duplicate_recipes);
    const root = [
      "# Generated by pi-agent: the workspace justfile and the project justfile, merged.",
      "# The workspace's comes first, so its recipes win on a name clash.",
      ...(allow ? ["set allow-duplicate-recipes"] : []),
      ...files.map((f) => `import ${literal(f.path)}`),
      "",
    ].join("\n");
    justfile = await writeGenerated("justfile", root);
    merged = await dump(run, justfile).catch((err: Error) => {
      throw new Error(`Cannot merge ${files.map((f) => f.label).join(" and ")}: ${err.message}`);
    });
  }
  return { sources: files.map((f) => f.label), justfile, workdir: o.cwd, recipes: recipesOf(merged) };
}
