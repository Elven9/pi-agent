import { appendFile, mkdir, readdir, readFile, realpath, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { CliError, type CliRunner, type ProjectSetting } from "./project-source.ts";

/**
 * Git worktrees for the worktree extension (src/worktree/index.ts): where they are stored, and
 * the git operations behind its tools and `/worktree` command.
 *
 * Folder for new worktrees, first that is set:
 * 1. `worktreeDir` of the `project` entry in settings.json (relative: against a local project's
 *    folder, else the cwd)
 * 2. `worktree.dir`, this extension's own entry in settings.json (relative: against the cwd)
 * 3. `.pi/worktree` in a local project's folder, else in the cwd
 *
 * A worktree goes to `<folder>/<repo>-wt/<branch, "/" replaced by "-">`.
 */

/** Key of the worktree entry in pi's settings.json. */
export const WORKTREE_SETTING = "worktree";
/** Default folder, relative to the local project's folder or the cwd. */
export const DEFAULT_WORKTREE_DIR = join(".pi", "worktree");

const Line = Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" });

const WorktreeSettingSchema = Type.Object(
  {
    /** Folder for new worktrees; `~` is expanded, a relative path is resolved against the cwd. */
    dir: Type.Optional(Line),
  },
  { additionalProperties: false },
);
export type WorktreeSetting = Static<typeof WorktreeSettingSchema>;

/** The `worktree` entry from pi's merged settings; undefined without one. Throws when invalid. */
export function worktreeSetting(settings: unknown): WorktreeSetting | undefined {
  const raw = (settings as Record<string, unknown> | undefined)?.[WORKTREE_SETTING];
  if (raw === undefined) return undefined;
  if (!Value.Check(WorktreeSettingSchema, raw)) {
    const errors =
      typeof raw !== "object" || raw === null || Array.isArray(raw)
        ? ["/ must be an object"]
        : Value.Errors(WorktreeSettingSchema, raw)
            .filter((e) => e.keyword !== "additionalProperties")
            .map((e) => `${e.instancePath || "/"} ${e.message === "schema is false" ? "is not a known key" : e.message}`);
    throw new Error(`Invalid "${WORKTREE_SETTING}" in settings.json:\n${errors.join("\n")}`);
  }
  return raw;
}

/** `~` and `~/...` to the home folder; other paths unchanged. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** `path` (with `~` expanded) resolved against `base`. */
export const resolveFrom = (base: string, path: string, home?: string) => resolve(base, expandHome(path, home));

/** Folder for new worktrees (see the top of this file). Every input path is absolute. */
export function resolveWorktreeDir(o: {
  /** `project.worktreeDir`, already resolved. */
  projectWorktreeDir?: string;
  /** `worktree.dir` as written in settings.json. */
  settingDir?: string;
  /** A local project's folder. */
  projectFolder?: string;
  cwd: string;
  home?: string;
}): string {
  if (o.projectWorktreeDir) return o.projectWorktreeDir;
  if (o.settingDir) return resolveFrom(o.cwd, o.settingDir, o.home);
  return join(o.projectFolder ?? o.cwd, DEFAULT_WORKTREE_DIR);
}

/** Folder name of a branch's worktree. */
export const worktreeFolder = (branch: string) => branch.replaceAll("/", "-");

/** Where a new worktree of `repo` (its main checkout) for `branch` goes. */
export const worktreePath = (dir: string, repo: string, branch: string) => join(dir, `${basename(repo)}-wt`, worktreeFolder(branch));

/** Whether `path` is `root` or inside it (both absolute, compared as given). */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** `realpath` of the path, or of its nearest existing ancestor with the rest appended. */
export async function realpathNearest(path: string): Promise<string> {
  const rest: string[] = [];
  for (let p = resolve(path); ; ) {
    try {
      return join(await realpath(p), ...rest.reverse());
    } catch {
      const parent = dirname(p);
      if (parent === p) return resolve(path);
      rest.push(basename(p));
      p = parent;
    }
  }
}

export interface WorktreeInfo {
  path: string;
  head?: string;
  /** Branch name without `refs/heads/`; undefined when detached (or bare). */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain` output; the main checkout comes first. */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = [];
  let cur: WorktreeInfo | undefined;
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      cur = undefined;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      cur = { path: value, bare: false, detached: false, locked: false, prunable: false };
      list.push(cur);
    } else if (cur) {
      if (key === "HEAD") cur.head = value;
      else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "bare") cur.bare = true;
      else if (key === "detached") cur.detached = true;
      else if (key === "locked") cur.locked = true;
      else if (key === "prunable") cur.prunable = true;
    }
  }
  return list;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** How `add` got the branch. */
export type AddedFrom = { kind: "existing" } | { kind: "tracking"; remote: string } | { kind: "new"; base: string };

/** Git operations; every command runs as `git -C <dir> ...` through the runner. */
export class Git {
  private readonly run: CliRunner;
  constructor(run: CliRunner) {
    this.run = run;
  }

  private git(dir: string, ...args: string[]) {
    return this.run("git", ["-C", dir, ...args]);
  }

  /** Whether the command succeeds (e.g. `show-ref --verify --quiet`). */
  private async ok(dir: string, ...args: string[]) {
    try {
      await this.git(dir, ...args);
      return true;
    } catch (err) {
      if (err instanceof CliError && err.missing) throw err;
      return false;
    }
  }

  /** The repository's shared `.git` folder (absolute). Throws when `dir` is not in a repository. */
  async commonDir(dir: string): Promise<string> {
    try {
      const out = (await this.git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim();
      return resolve(dir, out);
    } catch (err) {
      if (err instanceof CliError && err.missing) throw err;
      throw new Error(`${dir} is not in a git repository`);
    }
  }

  /** The main checkout of the repository `dir` is in (from any of its worktrees). */
  async mainCheckout(dir: string): Promise<string> {
    const common = await this.commonDir(dir);
    if (basename(common) !== ".git") throw new Error(`${dir}: a bare repository has no main checkout`);
    return dirname(common);
  }

  /** Whether `dir` is inside a git work tree. */
  isRepo(dir: string) {
    return this.ok(dir, "rev-parse", "--is-inside-work-tree");
  }

  async list(repo: string): Promise<WorktreeInfo[]> {
    return parseWorktreeList(await this.git(repo, "worktree", "list", "--porcelain"));
  }

  /** `<remote>/<branch>` for the first remote that has the branch. */
  async remoteBranch(repo: string, branch: string): Promise<string | undefined> {
    const remotes = (await this.git(repo, "remote")).split("\n").map((r) => r.trim()).filter(Boolean);
    for (const remote of remotes) {
      if (await this.ok(repo, "show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`)) return `${remote}/${branch}`;
    }
    return undefined;
  }

  /**
   * Adds a worktree for `branch` at `path`: checks out the local branch if there is one, else
   * tracks `<remote>/<branch>` if a remote has it, else creates the branch from `base` (default:
   * HEAD of the main checkout).
   */
  async add(o: { repo: string; branch: string; path: string; base?: string }): Promise<AddedFrom> {
    if (await exists(o.path)) throw new Error(`${o.path} already exists`);
    await mkdir(dirname(o.path), { recursive: true });
    if (await this.ok(o.repo, "show-ref", "--verify", "--quiet", `refs/heads/${o.branch}`)) {
      await this.git(o.repo, "worktree", "add", o.path, o.branch);
      return { kind: "existing" };
    }
    const remote = await this.remoteBranch(o.repo, o.branch);
    if (remote) {
      await this.git(o.repo, "worktree", "add", "--track", "-b", o.branch, o.path, remote);
      return { kind: "tracking", remote };
    }
    const base = o.base ?? "HEAD";
    await this.git(o.repo, "worktree", "add", "-b", o.branch, o.path, base);
    return { kind: "new", base };
  }

  /** Removes the worktree (git refuses when it has changes); the branch stays. */
  async remove(repo: string, path: string): Promise<void> {
    await this.git(repo, "worktree", "remove", path);
  }
}

/** Adds `/.pi/` to the repository's `info/exclude` (shared by all its worktrees) unless it is there. */
export async function excludePiFolder(commonDir: string): Promise<boolean> {
  const file = join(commonDir, "info", "exclude");
  const text = await readFile(file, "utf8").catch(() => "");
  if (text.split("\n").some((l) => l.trim() === "/.pi/" || l.trim() === "/.pi")) return false;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}/.pi/\n`);
  return true;
}

/** The project setting with its relative paths made absolute, as resolved from `cwd`. */
export function absoluteProjectSetting(setting: ProjectSetting, cwd: string): ProjectSetting {
  if (setting.type === "local") return { ...setting, dir: resolve(cwd, setting.dir) };
  return setting.worktreeDir ? { ...setting, worktreeDir: resolveFrom(cwd, setting.worktreeDir) } : setting;
}

/**
 * Gives a new worktree a `.pi/settings.json`, so pi started in it finds the project: a copy of
 * the main checkout's (project paths made absolute), else `{ project }` from this session.
 * Never overwrites one. Returns what it did.
 */
export async function seedSettings(o: {
  main: string;
  worktree: string;
  /** This session's `project` setting, if any. */
  project?: ProjectSetting;
  cwd: string;
}): Promise<"exists" | "copied" | "written" | "none"> {
  const dest = join(o.worktree, ".pi", "settings.json");
  if (await exists(dest)) return "exists";
  const src = join(o.main, ".pi", "settings.json");
  let content: string | undefined;
  let result: "copied" | "written" = "copied";
  const text = await readFile(src, "utf8").catch(() => undefined);
  if (text !== undefined) {
    content = text;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const p = json.project as ProjectSetting | undefined;
      if (p && typeof p === "object" && typeof p.type === "string") {
        if (p.type === "local" && typeof p.dir === "string") json.project = absoluteProjectSetting(p, o.main);
        else if (p.type !== "local" && typeof p.worktreeDir === "string") json.project = absoluteProjectSetting(p, o.main);
        content = `${JSON.stringify(json, null, 2)}\n`;
      }
    } catch {
      // Not JSON: copied as it is; pi reports it.
    }
  } else if (o.project) {
    content = `${JSON.stringify({ project: absoluteProjectSetting(o.project, o.cwd) }, null, 2)}\n`;
    result = "written";
  }
  if (content === undefined) return "none";
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content);
  return result;
}

/** Removes `<dir>/<repo>-wt` if it is empty now. */
export async function removeEmptyParent(path: string): Promise<void> {
  const parent = dirname(path);
  if (!basename(parent).endsWith("-wt")) return;
  if ((await readdir(parent).catch(() => ["?"])).length === 0) await rmdir(parent).catch(() => {});
}

/**
 * Repositories of the workspace: the one `cwd` is in (if any) and every direct subfolder that is
 * a repository's main checkout (has a `.git` folder), as main-checkout paths, without duplicates.
 */
export async function workspaceRepos(git: Git, cwd: string): Promise<string[]> {
  const repos: string[] = [];
  if (await git.isRepo(cwd)) repos.push(await git.mainCheckout(cwd));
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dotGit = await stat(join(cwd, e.name, ".git")).catch(() => undefined);
    if (!dotGit?.isDirectory()) continue;
    const dir = await realpath(join(cwd, e.name));
    if (!repos.includes(dir)) repos.push(dir);
  }
  return repos;
}
