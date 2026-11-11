import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, execCli, type CliRunner } from "./project-source.ts";
import type { Project } from "./project.ts";

/**
 * Project commands as `just` recipes (README "Project commands"). The commands section of block B
 * lists the recipes of the workspace's justfile (in the cwd) and of the project's justfile: the
 * agent runs the listed command instead of retyping commands from the prompt.
 *
 * The two are never merged: each runs on its own, so `justfile_directory()`, settings and imports
 * behave as when the file is run alone. Workspace recipes run with a plain `just` (it finds the
 * cwd's justfile). Project recipes run with `just --justfile <project justfile>
 * --working-directory <cwd>`, written out in full for every recipe, so they too run in the
 * workspace. A recipe in both files is listed twice, each with its own command.
 *
 * A remote project's justfile is written to a fixed path under the temp folder, named after the
 * source (not a hash), so block B stays byte-identical between runs on one machine.
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

/** One justfile and how to run its recipes. */
export interface JustSource {
  /** The justfile for the prompt: its path, or `justfile in <source>` for a remote project. */
  label: string;
  /** The justfile that is run. */
  justfile: string;
  /** The command before the recipe name: `just`, or `just --justfile … --working-directory …`. */
  command: string;
  /** Public recipes, sorted by name, then those of submodules. */
  recipes: JustRecipe[];
}

export interface JustCommands {
  /** Recipes run here (the workspace). */
  workdir: string;
  /** The justfiles found: the workspace's first, then the project's. */
  sources: JustSource[];
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

/** A remote project's justfile, at a fixed path under the temp folder named after its source. */
async function writeRemote(label: string, content: string): Promise<string> {
  const dir = join(tmpdir(), "pi-agent-just", label.replace(/^[a-z]+:\/\//, "").replace(/[^\w.@-]+/g, "_"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, PROJECT_JUSTFILE);
  await writeFile(path, content);
  return path;
}

/** A word for the shell: as is when safe, otherwise single-quoted. */
const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

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

/** Thrown by dump when the `just` binary is missing (execCli's ENOENT). */
class JustMissing extends Error {}

async function dump(run: CliRunner, justfile: string): Promise<JustDump> {
  const out = await run("just", ["--justfile", justfile, "--dump", "--dump-format", "json"]).catch((err: Error) => {
    if (err instanceof CliError && err.missing) throw new JustMissing(err.message);
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

/**
 * Finds the workspace's and the project's justfiles and loads their recipes. Undefined when
 * neither has one, or when `just` is not installed (then `warn` gets a message and no justfile
 * is read: there are no project commands). Throws when a justfile is invalid. A remote
 * project's justfile is copied to the temp folder (it must be self-contained: its imports,
 * modules and scripts are not fetched).
 */
export async function loadJustCommands(o: {
  cwd: string;
  project?: Project;
  run?: CliRunner;
  /** Gets a message when `just` is not installed. */
  warn?: (message: string) => void;
}): Promise<JustCommands | undefined> {
  const run = o.run ?? execCli;
  const files: Omit<JustSource, "recipes">[] = [];
  const workspace = await findJustfile(o.cwd);
  if (workspace) files.push({ label: workspace, justfile: workspace, command: "just" });
  const project = (justfile: string, label = justfile) =>
    files.push({ label, justfile, command: `just --justfile ${shellWord(justfile)} --working-directory ${shellWord(o.cwd)}` });
  const source = o.project?.source;
  if (source?.dir !== undefined) {
    const path = await findJustfile(source.dir);
    // The project folder as the workspace: its justfile counts once, as the workspace's.
    if (path && path !== workspace) project(path);
  } else if (source) {
    const content = await source.read(PROJECT_JUSTFILE);
    if (content !== undefined) project(await writeRemote(source.label, content), `${PROJECT_JUSTFILE} in ${source.label}`);
  }
  if (files.length === 0) return undefined;
  // Errors name the file at fault (dump).
  let dumps: JustDump[];
  try {
    dumps = await Promise.all(files.map((f) => dump(run, f.justfile)));
  } catch (err) {
    if (!(err instanceof JustMissing)) throw err;
    o.warn?.(`${err.message}: skipped the commands from ${files.map((f) => f.label).join(", ")}`);
    return undefined;
  }
  return { workdir: o.cwd, sources: files.map((f, i) => ({ ...f, recipes: recipesOf(dumps[i]!) })) };
}
