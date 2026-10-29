import { resolve } from "node:path";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ENTRY, PROJECT_CHANNEL, PROJECT_FLAG, PROJECT_READ, type ProjectAnnounced } from "../shared/protocol.ts";
import {
  estimateTokens,
  loadProject,
  loadProjectFrom,
  readAgentsMd,
  renderBlock,
  renderProjectSections,
  type Project,
  type ProjectSections,
} from "../shared/project.ts";
import { execCli, projectPath, projectSetting, settingSource, type CliRunner } from "../shared/project-source.ts";
import { splitSystemPrompt } from "./cache-split.ts";

/** project_read output limits, like pi's read tool. */
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const READ_PARAMETERS = Type.Object({
  path: Type.String({ description: "File path relative to the project folder, as listed in the project sections" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line to start from (1-based)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines" })),
});

export interface ProjectContextOptions {
  /** Runs gh/glab (tests replace it). */
  run?: CliRunner;
}

/**
 * Project context extension (docs/project-context-design.md). Adds "block B" to the system
 * prompt: the project's sections from `project.yaml` and `AGENTS.md` at the workspace root.
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
 * pi places extension sections after skills and `<cwd>`, which is where block B belongs.
 * Must load after the scenario-profile extension (its `<rules>` section belongs in block A);
 * scenario-profile checks this from the announcement sent at session start.
 *
 * Context files (pi's AGENTS.md/CLAUDE.md discovery, see `-nc`):
 * - With a project, pi's context files are dropped from every prompt (as if `-nc`): the
 *   project decides the context, and the workspace AGENTS.md is in block B instead.
 * - Without a project, if pi loaded context files, the extension adds nothing and leaves them
 *   to pi (plain `pi` with this package installed behaves as without it).
 * - Without a project and with no context files from pi (`-nc`, as the wrapper runs), the
 *   workspace AGENTS.md alone is block B.
 */
export function createProjectContext(options: ProjectContextOptions = {}) {
  const run = options.run ?? execCli;
  return function projectContext(pi: ExtensionAPI) {
    pi.registerFlag(PROJECT_FLAG, {
      type: "string",
      description: "Folder with project.yaml: adds its rules, commands, CLI tools, workflows and docs to the system prompt",
    });

    let project: Project | undefined;
    let sections: ProjectSections = {};
    let block = "";
    /** Whether the last prompt got block B (false: no project, pi loads its own context files). */
    let applied = false;
    /** A startup error in the TUI, printed on shutdown. */
    let startupError: string | undefined;

    /** Block B goes into the prompt unless there is no project and pi loaded context files. */
    const usesBlock = (piContextFiles: number) => project !== undefined || piContextFiles === 0;
    const remote = () => (project?.source.kind === "remote" ? project.source : undefined);

    /** Tell the context view (`/context`) what this extension adds. */
    const announce = () =>
      pi.events.emit(PROJECT_CHANNEL, {
        project: project && { name: project.manifest.name, dir: project.source.label },
        block: applied ? block : "",
        sections: Object.keys(sections),
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

    pi.on("session_start", async (_event, ctx) => {
      const dir = pi.getFlag(PROJECT_FLAG);
      try {
        // The flag wins; otherwise the project entry in settings.json, if any.
        if (typeof dir === "string" && dir !== "") {
          project = await loadProject(resolve(ctx.cwd, dir));
        } else {
          const setting = projectSetting(pi.getSettings());
          project = setting ? await loadProjectFrom(await settingSource(setting, ctx.cwd, run)) : undefined;
        }
        sections = renderProjectSections({ cwd: ctx.cwd, project, agentsMd: await readAgentsMd(ctx.cwd) });
        block = renderBlock(sections);
        applied = false;
        updateTools();
        announce();
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
      if (!applied) return;
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
          ctx.ui.notify(`No project context: no project, pi loads its own context files (${piContextFiles}).`, "info");
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
