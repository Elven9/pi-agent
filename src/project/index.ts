import { resolve } from "node:path";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ENTRY, PROJECT_CHANNEL, PROJECT_FLAG, PROJECT_READ, type ProjectAnnounced } from "../shared/protocol.ts";
import {
  estimateTokens,
  loadProject,
  loadProjectFrom,
  readAgentsMdFiles,
  renderBlock,
  renderProjectSections,
  SECTION,
  type Project,
  type ProjectSections,
} from "../shared/project.ts";
import { loadJustCommands } from "../shared/just.ts";
import {
  execCli,
  parseRepo,
  projectFolder,
  projectPath,
  projectSetting,
  remoteSource,
  settingSource,
  type CliRunner,
  type ProjectSetting,
} from "../shared/project-source.ts";
import { resolveFrom } from "../shared/worktree.ts";
import { splitSystemPrompt } from "./cache-split.ts";
import {
  ALLOW_SETUP_CHANGE_DESCRIPTION,
  ALLOW_SETUP_CHANGE_FLAG,
  decideSetup,
  projectEntry,
  projectKey,
  projectLabel,
  PROJECT_ENTRY_VERSION,
  sameEntry,
  sessionProject,
  sessionProjectEntry,
  type ProjectEntry,
  type ProjectEntrySource,
  type ProjectIdentity,
} from "../shared/session-setup.ts";

/** A project setting's identity, without loading it. */
function settingIdentity(setting: ProjectSetting, cwd: string): ProjectIdentity {
  if (setting.type === "local") return { kind: "local", dir: resolve(cwd, setting.dir) };
  const path = projectFolder(setting);
  return { kind: "remote", provider: setting.type, repo: parseRepo(setting).repo, ...(path && { path }) };
}

/** A recorded source's identity. */
function sourceIdentity(s: ProjectEntrySource): ProjectIdentity {
  return s.kind === "local" ? s : { kind: "remote", provider: s.provider, repo: s.repo, ...(s.path && { path: s.path }) };
}

/** project_read output limits, like pi's read tool. */
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const READ_PARAMETERS = Type.Object({
  path: Type.String({ description: "File path relative to the project folder, as listed in the project sections" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line to start from (1-based)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines" })),
});

export interface ProjectContextOptions {
  /** Runs gh/glab and just (tests replace it). */
  run?: CliRunner;
}

/**
 * Project context extension (docs/project-context-design.md). Adds "block B" to the system
 * prompt: the project's sections from `project.yaml` and the `AGENTS.md` files of the workspace
 * and its parent folders, up to the filesystem root (readAgentsMdFiles).
 * Both are read once per session, so block B stays byte-identical for the whole session (and
 * across sessions while the files don't change).
 *
 * The project comes from `--project <dir>` (a local folder) or, without the flag, from the
 * `project` entry in pi's settings.json: `type` `local` (a folder; a relative `dir` is
 * resolved against the session cwd) or `github` / `gitlab` (a repository pinned to a tag, read
 * with the logged-in `gh` / `glab`). A remote project's workflows and docs are read with the
 * `project_read` tool, active only then. (`PI_AGENT_PROJECT` is the wrapper's: it passes the
 * folder as `--project`.)
 *
 * Commands: the recipes of the workspace's and the project's justfiles, each listed with the
 * full command that runs it in the workspace (shared/just.ts). No environment is changed.
 *
 * pi places extension sections after skills and `<cwd>`, which is where block B belongs.
 * Must load after the scenario-profile extension (its `<rules>` section belongs in block A);
 * scenario-profile checks this from the announcement sent at session start.
 *
 * Context files (pi's AGENTS.md/CLAUDE.md discovery, see `-nc`):
 * - With a project, pi's context files are dropped from every prompt (as if `-nc`): the
 *   project decides the context, and the AGENTS.md files (workspace and parents) are in block B instead.
 * - Without a project, if pi loaded context files, the extension leaves them to pi and adds no
 *   sections. Only the commands (the cwd's justfile recipes), if any, are appended to pi's
 *   context files, as one more file (the justfile's path, the commands section's text), so they
 *   render last in pi's `<project_context>`.
 * - Without a project and with no context files from pi (`-nc`, as the wrapper runs), the
 *   AGENTS.md files (workspace and parents) alone are block B.
 */
export function createProjectContext(options: ProjectContextOptions = {}) {
  const run = options.run ?? execCli;
  return function projectContext(pi: ExtensionAPI) {
    pi.registerFlag(PROJECT_FLAG, {
      type: "string",
      description: "Folder with project.yaml: adds its rules, commands, CLI tools, workflows and docs to the system prompt",
    });
    // Also registered by the scenario-profile extension; pi lists it once and both read the same value.
    pi.registerFlag(ALLOW_SETUP_CHANGE_FLAG, { type: "boolean", description: ALLOW_SETUP_CHANGE_DESCRIPTION });

    /** A recorded project, as it was: a local folder, or the repository at the recorded commit. */
    const loadRecorded = async (s: ProjectEntrySource) => {
      if (s.kind === "local") return loadProject(s.dir);
      const setting = { type: s.provider, repo: s.repo, tag: s.tag, ...(s.path && { path: s.path }) };
      return loadProjectFrom(await remoteSource(setting, run, s.commit));
    };

    let project: Project | undefined;
    let sections: ProjectSections = {};
    let block = "";
    /** Whether the last prompt got block B (false: no project, pi loads its own context files). */
    let applied = false;
    /** Without a project: the commands, appended to pi's context files when block B is not used. */
    let commandsFile: { path: string; content: string } | undefined;
    /** A startup error in the TUI, printed on shutdown. */
    let startupError: string | undefined;
    /** `project.worktreeDir` from settings.json, resolved (for the worktree extension). */
    let worktreeDir: string | undefined;

    /** Block B goes into the prompt unless there is no project and pi loaded context files. */
    const usesBlock = (piContextFiles: number) => project !== undefined || piContextFiles === 0;
    const remote = () => (project?.source.kind === "remote" ? project.source : undefined);

    /** Tell the context view (`/context`) what this extension adds. */
    const announce = () =>
      pi.events.emit(PROJECT_CHANNEL, {
        project: project && { name: project.manifest.name, dir: project.source.label },
        block: applied ? block : "",
        sections: Object.keys(sections),
        ...(project?.manifest.skills && { skills: [...project.manifest.skills.include] }),
        ...(project?.dir !== undefined && { folder: project.dir }),
        ...(worktreeDir !== undefined && { worktreeDir }),
      } satisfies ProjectAnnounced);

    /**
     * project_read exists only with a remote project. Then it is registered with "codemode"
     * exposure and activated: declared to the model as a direct tool and callable from codemode
     * scripts, also with codemode.mode "only" (which hides only active tools with "direct"
     * exposure). Otherwise it is "hidden": pi lets scripts call (and codemode lists) a "codemode"
     * tool whenever it is registered, active or not, so without a remote project it would show up
     * in every session and change codemode's description.
     */
    let exposure: "hidden" | "codemode" = "hidden";
    const updateTools = () => {
      const wanted = remote() ? "codemode" : "hidden";
      if (wanted !== exposure) {
        exposure = wanted;
        pi.registerTool({ ...readTool, exposure });
      }
      const active = pi.getActiveTools();
      if (active.includes(PROJECT_READ) === (wanted === "codemode")) return;
      const others = active.filter((name) => name !== PROJECT_READ);
      pi.setActiveTools(wanted === "codemode" ? [...others, PROJECT_READ] : others);
    };

    const readTool = {
      name: PROJECT_READ,
      label: "Project: read",
      description:
        "Read a file of the project (its workflows and docs) from the project repository, at the version pinned for this run. " +
        `Output is limited to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB; use offset/limit for more.`,
      parameters: READ_PARAMETERS,
      annotations: { readOnlyHint: true },
      async execute(_id: string, params: { path: string; offset?: number; limit?: number }) {
        const source = remote();
        if (!source) throw new Error("This session has no remote project.");
        const path = projectPath(params.path);
        if (path === undefined) throw new Error(`${params.path}: not a path inside the project`);
        const content = await source.read(path);
        if (content === undefined) throw new Error(`${path}: no such file in the project (${source.label})`);
        const lines = content.split("\n");
        const start = (params.offset ?? 1) - 1;
        if (start > 0 && start >= lines.length) throw new Error(`offset ${params.offset} is beyond the end of ${path} (${lines.length} lines)`);
        const selected = lines.slice(start, params.limit ? start + params.limit : undefined).join("\n");
        const t = truncateHead(selected, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
        const end = start + t.outputLines;
        let text = t.content;
        if (t.truncated) text += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
        else if (params.limit && start + params.limit < lines.length) {
          text += `\n\n[${lines.length - start - params.limit} more lines. Use offset=${start + params.limit + 1} to continue.]`;
        }
        return { content: [{ type: "text" as const, text }], details: { path, commit: source.remote!.commit } };
      },
    };
    pi.registerTool({ ...readTool, exposure });

    pi.on("session_start", async (event, ctx) => {
      const dir = pi.getFlag(PROJECT_FLAG);
      worktreeDir = undefined;
      try {
        // The process's project: the flag wins; otherwise the project entry in settings.json, if any.
        const flagDir = typeof dir === "string" && dir !== "" ? resolve(ctx.cwd, dir) : undefined;
        const setting = flagDir === undefined ? projectSetting(pi.getSettings()) : undefined;
        const current: ProjectIdentity | undefined = flagDir !== undefined ? { kind: "local", dir: flagDir } : setting && settingIdentity(setting, ctx.cwd);
        // The session's setup is fixed (shared/session-setup.ts): recorded project vs the process's.
        const recordedEntry = sessionProject(ctx.sessionManager.getEntries());
        const recorded = recordedEntry && sourceIdentity(recordedEntry.source);
        const decision = decideSetup({
          what: "project",
          reason: event.reason,
          recorded,
          current,
          key: projectKey,
          label: projectLabel,
          allowChange: pi.getFlag(ALLOW_SETUP_CHANGE_FLAG) === true,
        });
        if ("error" in decision) throw new Error(decision.error);
        const usesSetting = decision.use === "current" ? setting !== undefined : !!current && setting !== undefined && projectKey(current) === projectKey(recorded!);
        if (decision.use === "recorded") {
          project = await loadRecorded(recordedEntry!.source);
          if (ctx.hasUI && (!current || projectKey(current) !== projectKey(recorded!))) {
            ctx.ui.notify(`[pi-agent] Project ${recordedEntry!.name} (${projectLabel(recorded!)}), as recorded in this session`, "info");
          }
        } else if (flagDir !== undefined) {
          project = await loadProject(flagDir);
        } else {
          project = setting ? await loadProjectFrom(await settingSource(setting, ctx.cwd, run)) : undefined;
        }
        // Relative: against a local project's folder, else the cwd.
        if (usesSetting && setting?.worktreeDir) worktreeDir = resolveFrom(project?.dir ?? ctx.cwd, setting.worktreeDir);
        // Without just installed there are no commands: warn and go on.
        const warn = (message: string) =>
          ctx.mode === "tui" ? ctx.ui.notify(`[pi-agent] ${message}`, "warning") : console.error(`[pi-agent] warning: ${message}`);
        const just = await loadJustCommands({ cwd: ctx.cwd, project, run, warn });
        sections = renderProjectSections({ cwd: ctx.cwd, project, agentsMd: await readAgentsMdFiles(ctx.cwd), just });
        block = renderBlock(sections);
        const commands = sections[SECTION.commands];
        commandsFile = !project && commands && just ? { path: just.sources[0]!.justfile, content: commands } : undefined;
        applied = false;
        updateTools();
        announce();
        const last = sessionProjectEntry(ctx.sessionManager.getEntries());
        if (project) {
          const entry = projectEntry(project);
          if (!sameEntry(last, entry)) pi.appendEntry<ProjectEntry>(ENTRY.project, entry);
        } else if (last && last.name !== null) {
          // Only after --allow-setup-change dropped a recorded project.
          pi.appendEntry<ProjectEntry>(ENTRY.project, { version: PROJECT_ENTRY_VERSION, name: null });
        }
      } catch (err) {
        project = undefined;
        updateTools();
        // Startup entries are not streamed in --mode json, so also tell stderr. The TUI would
        // paint over a line written now, so there it is printed once the TUI has stopped.
        const message = (err as Error).message;
        if (ctx.mode === "tui") startupError = message;
        else console.error(`[pi-agent] ${message}`);
        pi.appendEntry(ENTRY.error, { message });
        ctx.shutdown();
      }
    });

    // Interactive quit stops the TUI before emitting session_shutdown.
    pi.on("session_shutdown", () => {
      if (startupError === undefined) return;
      console.error(`[pi-agent] ${startupError}`);
      startupError = undefined;
    });

    // Set on every prompt (pi rebuilds the options from its base each time); the content never
    // changes within a session, so pi sees no delta.
    pi.on("before_agent_start", (event) => {
      const options = event.systemPromptOptions;
      applied = usesBlock(options.contextFiles?.length ?? 0);
      announce();
      if (!applied) {
        if (commandsFile) options.contextFiles = [...(options.contextFiles ?? []), commandsFile];
        return;
      }
      if (project) options.contextFiles = [];
      Object.assign(options.sections, sections);
    });

    // Separate cache markers for A (shared by all projects) and B (this project).
    pi.on("before_provider_request", (event) =>
      applied ? splitSystemPrompt(event.payload, block) : undefined,
    );

    pi.registerCommand("project", {
      description: "Show the project context in the system prompt (block B) and its size",
      handler: async (_args, ctx) => {
        const piContextFiles = ctx.getSystemPromptOptions().contextFiles?.length ?? 0;
        if (!usesBlock(piContextFiles)) {
          const appended = commandsFile ? `; the commands (~${estimateTokens(commandsFile.content)} tokens) are appended to them as ${commandsFile.path}` : "";
          ctx.ui.notify(`No project context: no project, pi loads its own context files (${piContextFiles})${appended}.`, "info");
          return;
        }
        const names = Object.keys(sections);
        if (names.length === 0) {
          ctx.ui.notify("No project context: no project and no AGENTS.md in the workspace.", "info");
          return;
        }
        const r = remote()?.remote;
        const lines = [
          project
            ? `Project: ${project.manifest.name} (${project.source.label}${r ? ` = ${r.commit.slice(0, 12)}` : ""}); pi's context files are off`
            : "Project: none (AGENTS.md only)",
          ...names.map((name) => `  <${name}>  ~${estimateTokens(sections[name])} tokens`),
          `Block B total: ~${estimateTokens(block)} tokens`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      },
    });
  };
}

export default createProjectContext();
