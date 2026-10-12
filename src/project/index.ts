import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY, PROJECT_FLAG } from "../shared/protocol.ts";
import {
  estimateTokens,
  loadProject,
  readAgentsMd,
  renderBlock,
  renderProjectSections,
  type Project,
  type ProjectSections,
} from "../shared/project.ts";
import { splitSystemPrompt } from "./cache-split.ts";

/**
 * Project context extension (docs/project-context-design.md). Adds "block B" to the system
 * prompt: the project's sections from `--project <dir>/project.yaml` and `AGENTS.md` at the
 * workspace root. Both are read once per session, so block B stays byte-identical for the
 * whole session (and across sessions while the files don't change).
 *
 * pi places extension sections after skills and `<cwd>`, which is where block B belongs.
 *
 * Context files (pi's AGENTS.md/CLAUDE.md discovery, see `-nc`):
 * - With `--project`, pi's context files are dropped from every prompt (as if `-nc`): the
 *   project decides the context, and the workspace AGENTS.md is in block B instead.
 * - Without `--project`, if pi loaded context files, the extension adds nothing and leaves them
 *   to pi (plain `pi` with this package installed behaves as without it).
 * - Without `--project` and with no context files from pi (`-nc`, as the wrapper runs), the
 *   workspace AGENTS.md alone is block B.
 */
export default function projectContext(pi: ExtensionAPI) {
  pi.registerFlag(PROJECT_FLAG, {
    type: "string",
    description: "Folder with project.yaml: adds its rules, commands, CLI tools, workflows and docs to the system prompt",
  });

  let project: Project | undefined;
  let sections: ProjectSections = {};
  let block = "";
  /** Whether the last prompt got block B (false: no --project, pi loads its own context files). */
  let applied = false;

  /** Block B goes into the prompt unless there is no --project and pi loaded context files. */
  const usesBlock = (piContextFiles: number) => project !== undefined || piContextFiles === 0;

  pi.on("session_start", async (_event, ctx) => {
    const dir = pi.getFlag(PROJECT_FLAG);
    try {
      project = typeof dir === "string" && dir !== "" ? await loadProject(resolve(ctx.cwd, dir)) : undefined;
      sections = renderProjectSections({ cwd: ctx.cwd, project, agentsMd: await readAgentsMd(ctx.cwd) });
      block = renderBlock(sections);
    } catch (err) {
      // Startup entries are not streamed in --mode json, so also tell stderr.
      const message = (err as Error).message;
      console.error(`[pi-agent] ${message}`);
      pi.appendEntry(ENTRY.error, { message });
      ctx.shutdown();
    }
  });

  // Set on every prompt (pi rebuilds the options from its base each time); the content never
  // changes within a session, so pi sees no delta.
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    applied = usesBlock(options.contextFiles?.length ?? 0);
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
        ctx.ui.notify(`No project context: no --project, pi loads its own context files (${piContextFiles}).`, "info");
        return;
      }
      const names = Object.keys(sections);
      if (names.length === 0) {
        ctx.ui.notify("No project context: no --project and no AGENTS.md in the workspace.", "info");
        return;
      }
      const lines = [
        project
          ? `Project: ${project.manifest.name} (${project.dir}); pi's context files are off`
          : "Project: none (AGENTS.md only)",
        ...names.map((name) => `  <${name}>  ~${estimateTokens(sections[name])} tokens`),
        `Block B total: ~${estimateTokens(block)} tokens`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
