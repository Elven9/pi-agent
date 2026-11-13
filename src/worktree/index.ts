import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ENTRY, PROJECT_CHANNEL, type ProjectAnnounced } from "../shared/protocol.ts";
import { execCli, projectSetting, type CliRunner } from "../shared/project-source.ts";
import {
  excludePiFolder,
  expandHome,
  Git,
  isInside,
  realpathNearest,
  removeEmptyParent,
  resolveWorktreeDir,
  seedSettings,
  workspaceRepos,
  worktreePath,
  worktreeSetting,
  type AddedFrom,
  type WorktreeInfo,
  type WorktreeSetting,
} from "../shared/worktree.ts";

export const WORKTREE_ENTRY_VERSION = 1;

/** The entered worktree. */
export interface ActiveWorktree {
  /** Worktree folder (absolute, real path). */
  path: string;
  /** Main checkout of its repository. */
  repo: string;
  branch: string;
}

/** Data of a `pi-agent.worktree` entry: the worktree entered, or none (left). */
export interface WorktreeEntry {
  version: typeof WORKTREE_ENTRY_VERSION;
  worktree?: ActiveWorktree;
}

/** System prompt section shown while a worktree is entered. */
export const SECTION = "worktree";
/** Tools whose `path` is resolved against the entered worktree. */
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);
/** Tools that default to the cwd without a `path`. */
const DIR_TOOLS = new Set(["ls", "grep", "find"]);
/** Tools that may only change files inside the entered worktree. */
const WRITE_TOOLS = new Set(["write", "edit"]);

export const TOOL = {
  add: "worktree_add",
  enter: "worktree_enter",
  remove: "worktree_remove",
  list: "worktree_list",
} as const;

const REPO = Type.Optional(
  Type.String({
    description:
      "Repository folder (relative to the session's working directory, or absolute). Default: the entered worktree's repository, else the one the working directory is in.",
  }),
);
const BRANCH = Type.String({ minLength: 1, description: "Branch name, e.g. feat/login" });

const ADD_PARAMETERS = Type.Object({
  branch: BRANCH,
  repo: REPO,
  base: Type.Optional(Type.String({ minLength: 1, description: "Start point of a new branch. Default: HEAD of the repository's main checkout" })),
  enter: Type.Optional(Type.Boolean({ description: "Also enter the new worktree (like worktree_enter)" })),
});
const ENTER_PARAMETERS = Type.Object({ branch: BRANCH, repo: REPO });
const REMOVE_PARAMETERS = Type.Object({ branch: BRANCH, repo: REPO });
const LIST_PARAMETERS = Type.Object({});

/** Single-quoted for sh. */
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * A tool's `path` made absolute against the worktree. Absolute and `~` paths are left as they
 * are (a leading `@`, which pi's tools strip, is kept with them).
 */
export function rebasePath(path: string, worktree: string): string {
  const p = path.startsWith("@") ? path.slice(1) : path;
  if (p === "~" || p.startsWith("~/") || isAbsolute(p)) return path;
  return join(worktree, p);
}

/** The section text for the entered worktree. */
export function worktreeSection(active: ActiveWorktree, cwd: string): string {
  return [
    `You are working in the git worktree ${active.path} (repository ${active.repo}, branch ${active.branch}), not in ${cwd}.`,
    "Relative paths of read, write, edit, ls, grep and find, and every bash command, run in the worktree.",
    "write and edit outside the worktree are blocked. Only the user can leave the worktree (/worktree exit).",
  ].join("\n");
}

/** Lines for `worktree_list` / `/worktree list`: one block per repository, `*` on the current worktree. */
export function formatList(repos: Array<{ repo: string; worktrees: WorktreeInfo[] }>, current: string | undefined): string {
  if (repos.length === 0) return "No git repositories in the workspace.";
  return repos
    .map(({ repo, worktrees }) =>
      [
        `${basename(repo)} (${repo})`,
        ...worktrees.map((w) => {
          const what = w.bare ? "bare" : w.branch ? `[${w.branch}]` : `detached ${w.head?.slice(0, 12) ?? ""}`.trimEnd();
          const flags = [w.locked && "locked", w.prunable && "prunable"].filter(Boolean).join(", ");
          return `${w.path === current ? "*" : " "} ${w.path}  ${what}${flags ? ` (${flags})` : ""}`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
}

/** The worktree path (of all listed) that contains `dir` most closely. */
function containing(paths: string[], dir: string): string | undefined {
  return paths.filter((p) => isInside(dir, p)).sort((a, b) => b.length - a.length)[0];
}

const describeAdded = (from: AddedFrom, branch: string) =>
  from.kind === "existing"
    ? `checked out the existing branch ${branch}`
    : from.kind === "tracking"
      ? `created ${branch} tracking ${from.remote}`
      : `created ${branch} from ${from.base}`;

export interface WorktreeOptions {
  /** Runs git (tests may replace it). */
  run?: CliRunner;
  /** Temp folder that write/edit may change while a worktree is entered. Default: the OS temp folder. */
  tempDir?: string;
}

/**
 * Worktree extension (agent docs: src/agent-docs/docs/worktree.md). Tools `worktree_add`,
 * `worktree_enter`, `worktree_remove`, `worktree_list` and the `/worktree` command; the folder for
 * new worktrees comes from shared/worktree.ts (`project.worktreeDir`, then `worktree.dir`, then
 * `.pi/worktree` in the local project's folder or the cwd). Must load after the project extension
 * (it reads PROJECT_CHANNEL for the project's folder and `worktreeDir`).
 *
 * Entering a worktree (a tool or `/worktree enter`) is recorded as a `pi-agent.worktree` entry, so
 * it survives /resume and follows /tree. While entered:
 * - `read`, `write`, `edit`, `ls`, `grep`, `find`: a relative `path` (or none, for the last three)
 *   is made absolute against the worktree; `bash` commands start with a `cd` into it. This is done
 *   in `tool_call`, which also sees the calls from codemode scripts.
 * - `write` and `edit` outside the worktree (and the temp folder) are blocked. Reads and bash are not.
 * - The prompt gets a `<worktree>` section. Only the user leaves (`/worktree exit`).
 */
export function createWorktree(options: WorktreeOptions = {}) {
  const git = new Git(options.run ?? execCli);
  return function worktree(pi: ExtensionAPI) {
    let active: ActiveWorktree | undefined;
    let setting: WorktreeSetting | undefined;
    /** Last project announcement (sent from the project extension's session_start, before ours). */
    let project: ProjectAnnounced | undefined;
    pi.events.on(PROJECT_CHANNEL, (data) => void (project = data as ProjectAnnounced));

    const worktreeDir = (cwd: string) =>
      resolveWorktreeDir({ projectWorktreeDir: project?.worktreeDir, settingDir: setting?.dir, projectFolder: project?.folder, cwd });

    /** Main checkout for a `repo` argument (see REPO). */
    const repoOf = async (repo: string | undefined, cwd: string) => {
      if (repo !== undefined && repo !== "") return git.mainCheckout(resolve(cwd, expandHome(repo)));
      if (active) return active.repo;
      if (!(await git.isRepo(cwd))) throw new Error(`${cwd} is not in a git repository; pass repo`);
      return git.mainCheckout(cwd);
    };

    const findWorktree = async (repo: string, branch: string) => {
      const found = (await git.list(repo)).find((w) => w.branch === branch);
      if (!found) throw new Error(`${basename(repo)} has no worktree for branch ${branch} (see worktree_list)`);
      return found;
    };

    const setActive = (next: ActiveWorktree | undefined) => {
      active = next;
      pi.appendEntry<WorktreeEntry>(ENTRY.worktree, { version: WORKTREE_ENTRY_VERSION, ...(next && { worktree: next }) });
    };

    const enter = async (repo: string, branch: string) => {
      const w = await findWorktree(repo, branch);
      setActive({ path: await realpathNearest(w.path), repo, branch });
      return active!;
    };

    const add = async (p: { branch: string; repo?: string; base?: string; enter?: boolean }, cwd: string) => {
      const repo = await repoOf(p.repo, cwd);
      const path = worktreePath(worktreeDir(cwd), repo, p.branch);
      const from = await git.add({ repo, branch: p.branch, path, base: p.base });
      await excludePiFolder(await git.commonDir(repo));
      const settings = await seedSettings({ main: repo, worktree: path, project: safeProjectSetting(), cwd });
      const lines = [`Worktree ${path}: ${describeAdded(from, p.branch)}.`];
      if (settings === "copied") lines.push(`Copied ${join(repo, ".pi", "settings.json")} into it.`);
      if (settings === "written") lines.push("Wrote .pi/settings.json with this session's project into it.");
      if (p.enter) {
        await enter(repo, p.branch);
        lines.push("Entered it: tools now run there.");
      }
      return { text: lines.join("\n"), details: { path, repo, branch: p.branch, from, settings, entered: Boolean(p.enter) } };
    };

    /** The project setting, for `.pi/settings.json` in new worktrees; invalid is ignored (the project extension reports it). */
    const safeProjectSetting = () => {
      try {
        return projectSetting(pi.getSettings());
      } catch {
        return undefined;
      }
    };

    const remove = async (p: { branch: string; repo?: string }, cwd: string) => {
      const repo = await repoOf(p.repo, cwd);
      const w = await findWorktree(repo, p.branch);
      const path = await realpathNearest(w.path);
      if (path === (await realpathNearest(repo))) throw new Error(`${path} is the main checkout of ${basename(repo)}, not a worktree`);
      if (active && active.path === path) throw new Error(`The session is in ${path}; the user must leave it first (/worktree exit)`);
      await git.remove(repo, w.path);
      await removeEmptyParent(w.path);
      return { text: `Removed worktree ${w.path}; branch ${p.branch} is kept.`, details: { path: w.path, repo, branch: p.branch } };
    };

    const list = async (cwd: string) => {
      const repos = await workspaceRepos(git, cwd);
      if (active && !repos.includes(active.repo)) repos.push(active.repo);
      const all = await Promise.all(
        repos.map(async (repo) => ({
          repo,
          worktrees: await Promise.all((await git.list(repo)).map(async (w) => ({ ...w, path: await realpathNearest(w.path) }))),
        })),
      );
      const current = active?.path ?? containing(all.flatMap((r) => r.worktrees.map((w) => w.path)), await realpathNearest(cwd));
      return { text: formatList(all, current), details: { repos: all, current } };
    };

    const result = (r: { text: string; details: unknown }) => ({ content: [{ type: "text" as const, text: r.text }], details: r.details });

    pi.registerTool({
      name: TOOL.add,
      label: "Worktree: add",
      description:
        "Create a git worktree for a branch in the worktree folder (<folder>/<repo>-wt/<branch with / as ->). " +
        "Checks out the local branch if it exists, else tracks a remote branch of that name, else creates the branch from base. " +
        "With enter: true, also enters it (see worktree_enter).",
      parameters: ADD_PARAMETERS,
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return result(await add(params, ctx.cwd));
      },
    });

    pi.registerTool({
      name: TOOL.enter,
      label: "Worktree: enter",
      description:
        "Enter an existing worktree (by branch) for the rest of the session: relative paths of read/write/edit/ls/grep/find and " +
        "every bash command run there, and write/edit outside it are blocked. Only the user can leave it.",
      parameters: ENTER_PARAMETERS,
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const w = await enter(await repoOf(params.repo, ctx.cwd), params.branch);
        return result({ text: `Entered worktree ${w.path} (branch ${w.branch}). Tools now run there.`, details: w });
      },
    });

    pi.registerTool({
      name: TOOL.remove,
      label: "Worktree: remove",
      description:
        "Remove the worktree of a branch. Keeps the branch; fails when the worktree has uncommitted changes or the session is in it.",
      parameters: REMOVE_PARAMETERS,
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return result(await remove(params, ctx.cwd));
      },
    });

    pi.registerTool({
      name: TOOL.list,
      label: "Worktree: list",
      description: "List the worktrees of every repository in the workspace; * marks the one the session works in.",
      parameters: LIST_PARAMETERS,
      annotations: { readOnlyHint: true },
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        return result(await list(ctx.cwd));
      },
    });

    /** The entered worktree on the current branch of the session (last entry wins). */
    const restore = async (ctx: ExtensionContext) => {
      let last: WorktreeEntry | undefined;
      for (const e of ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>) {
        if (e.type === "custom" && e.customType === ENTRY.worktree) last = e.data as WorktreeEntry;
      }
      active = last?.worktree;
      if (active && !(await stat(active.path).then((s) => s.isDirectory(), () => false))) {
        const gone = active.path;
        setActive(undefined);
        notify(ctx, `Worktree ${gone} no longer exists; left it.`, "warning");
      }
    };

    const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
      if (ctx.hasUI) ctx.ui.notify(message, level);
      else if (level !== "info") console.error(`[pi-agent] ${message}`);
    };

    pi.on("session_start", async (_event, ctx) => {
      try {
        setting = worktreeSetting(pi.getSettings());
      } catch (err) {
        const message = (err as Error).message;
        console.error(`[pi-agent] ${message}`);
        pi.appendEntry(ENTRY.error, { message });
        ctx.shutdown();
        return;
      }
      await restore(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => restore(ctx));

    /** Roots `write`/`edit` may change while a worktree is entered. */
    const writableRoots = async () => Promise.all([active!.path, options.tempDir ?? tmpdir()].map(realpathNearest));

    pi.on("tool_call", async (event) => {
      if (!active) return;
      const input = event.input as Record<string, unknown>;
      if (event.toolName === "bash" && typeof input.command === "string") {
        input.command = `cd ${shellQuote(active.path)} || exit 1\n${input.command}`;
        return;
      }
      if (!PATH_TOOLS.has(event.toolName)) return;
      if (typeof input.path === "string") input.path = rebasePath(input.path, active.path);
      else if (input.path === undefined && DIR_TOOLS.has(event.toolName)) input.path = active.path;
      if (!WRITE_TOOLS.has(event.toolName) || typeof input.path !== "string") return;
      const raw = input.path.startsWith("@") ? input.path.slice(1) : input.path;
      const target = await realpathNearest(expandHome(raw));
      if ((await writableRoots()).some((root) => isInside(target, root))) return;
      return {
        block: true,
        reason: `${target} is outside the worktree ${active.path}: ${event.toolName} is limited to the worktree. Ask the user to leave it (/worktree exit) first.`,
      };
    });

    pi.on("before_agent_start", (event, ctx) => {
      if (active) event.systemPromptOptions.sections[SECTION] = worktreeSection(active, ctx.cwd);
    });

    const USAGE = [
      "/worktree list",
      "/worktree add <branch> [--repo <dir>] [--base <ref>] [--enter]",
      "/worktree enter <branch> [--repo <dir>]",
      "/worktree remove <branch> [--repo <dir>]",
      "/worktree exit",
    ].join("\n");
    const SUBCOMMANDS = ["list", "add", "enter", "remove", "exit"];

    pi.registerCommand("worktree", {
      description: "Git worktrees: list, add, enter, remove, exit (the one the session works in)",
      getArgumentCompletions: (prefix) => {
        if (prefix.includes(" ")) return null;
        const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
        return items.length ? items : null;
      },
      handler: async (args, ctx) => {
        let parsed: ReturnType<typeof parseCommand>;
        try {
          parsed = parseCommand(args);
        } catch (err) {
          ctx.ui.notify(`${(err as Error).message}\n${USAGE}`, "error");
          return;
        }
        try {
          switch (parsed.sub) {
            case "list":
              ctx.ui.notify((await list(ctx.cwd)).text, "info");
              return;
            case "add":
              ctx.ui.notify((await add(parsed, ctx.cwd)).text, "info");
              return;
            case "enter": {
              const w = await enter(await repoOf(parsed.repo, ctx.cwd), parsed.branch);
              ctx.ui.notify(`Entered worktree ${w.path} (branch ${w.branch}).`, "info");
              return;
            }
            case "remove":
              ctx.ui.notify((await remove(parsed, ctx.cwd)).text, "info");
              return;
            case "exit": {
              if (!active) {
                ctx.ui.notify("Not in a worktree.", "info");
                return;
              }
              const left = active.path;
              setActive(undefined);
              ctx.ui.notify(`Left worktree ${left}; tools run in ${ctx.cwd} again.`, "info");
              return;
            }
          }
        } catch (err) {
          ctx.ui.notify((err as Error).message, "error");
        }
      },
    });
  };
}

type Command =
  | { sub: "list" | "exit" }
  | { sub: "add"; branch: string; repo?: string; base?: string; enter?: boolean }
  | { sub: "enter" | "remove"; branch: string; repo?: string };

/** `/worktree` arguments (see USAGE). Throws on unknown or missing arguments. */
export function parseCommand(args: string): Command {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const sub = words.shift() ?? "list";
  if (sub === "list" || sub === "exit") {
    if (words.length) throw new Error(`/worktree ${sub} takes no arguments`);
    return { sub };
  }
  if (sub !== "add" && sub !== "enter" && sub !== "remove") throw new Error(`Unknown subcommand "${sub}"`);
  const opts: { repo?: string; base?: string; enter?: boolean } = {};
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const value = () => {
      const v = words[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${w} needs a value`);
      return v;
    };
    if (w === "--repo") opts.repo = value();
    else if (w === "--base" && sub === "add") opts.base = value();
    else if (w === "--enter" && sub === "add") opts.enter = true;
    else if (w.startsWith("--")) throw new Error(`Unknown option ${w}`);
    else rest.push(w);
  }
  if (rest.length !== 1) throw new Error(`/worktree ${sub} needs exactly one branch`);
  return { sub, branch: rest[0]!, ...opts };
}

export default createWorktree();
