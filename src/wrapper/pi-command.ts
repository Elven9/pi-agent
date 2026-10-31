import { PROJECT_FLAG, PROJECT_READ, SCENARIO_FLAG, SUBMIT_RESULT } from "../shared/protocol.ts";
import { TAGS_FLAG } from "../shared/tags.ts";
import type { Scenario } from "../shared/scenarios/index.ts";
import { TOOL_REF_TOOLS } from "../shared/tool-ref.ts";
import type { Task } from "../shared/task.ts";

const CODEMODE = "codemode";

export interface PiCommandOptions {
  task: Task;
  scenario: Scenario;
  /** Bundled runner extension (dist/extension.js). */
  extensionPath: string;
  /** Bundled scenario profile extension (dist/scenario-profile.js): system prompt, tools, skills. */
  scenarioProfileExtensionPath: string;
  /** Bundled project context extension (dist/project.js). Always loaded: it also adds AGENTS.md. */
  projectExtensionPath: string;
  /** Bundled metrics extension (dist/metrics.js): writes pi-agent.metrics entries. */
  metricsExtensionPath: string;
  /** Bundled tags extension (dist/tags.js): records the task's tags in the session file. */
  tagsExtensionPath: string;
  /** Bundled tool-ref extension (dist/tool-ref.js): tool-call handles. Loaded last (see its load-order check). */
  toolRefExtensionPath: string;
  /** Folder with a validated project.yaml (local project). */
  projectDir?: string;
  /** Remote project (from settings.json): the agent reads its files with project_read. */
  projectRead?: boolean;
  /** Skill directories to load (absolute; shared, the scenario's, then its included external skills). */
  skillPaths: string[];
  sessionDir: string;
  /** Previous session file to fork from. */
  resumeFrom?: string;
}

/**
 * pi CLI arguments for one scenario run. Loads nothing implicitly: no discovered extensions,
 * skills, prompt templates, context files, themes, MCP or project config (the workdir is not
 * trusted). Only the runner, scenario profile, project, metrics, tags and tool-ref extensions (tool-ref
 * last: no later extension may replace tool results and drop its trailers), the given skills
 * and the scenario's tools. The system prompt comes from the scenario profile extension (`--scenario`),
 * which also applies the tools and skills in-process; `--tools` and `--skill` stay as the hard
 * limits. Context files (AGENTS.md) come from the project extension, after skills, not from pi (`-nc`).
 * `-ne` also turns off pi's built-in extensions, so a scenario with the `codemode` tool loads
 * `builtin:codemode` explicitly (first, as pi loads built-ins). Its mode (`codemode.mode`) comes
 * from the settings in the agent dir.
 */
export function piArgs(o: PiCommandOptions): string[] {
  const { task, scenario } = o;
  return [
    "--mode", "json",
    "-ne",
    ...(scenario.tools.includes(CODEMODE) ? ["-e", `builtin:${CODEMODE}`] : []),
    "-e", o.extensionPath, "-e", o.scenarioProfileExtensionPath,
    "-e", o.projectExtensionPath, "-e", o.metricsExtensionPath,
    "-e", o.tagsExtensionPath, "-e", o.toolRefExtensionPath,
    "--no-mcp",
    "-ns", ...o.skillPaths.flatMap((p) => ["--skill", p]),
    "-np",
    "-nc",
    "--no-themes",
    "-na",
    "--offline",
    "--session-dir", o.sessionDir,
    ...(o.resumeFrom ? ["--fork", o.resumeFrom] : []),
    "--tools", [...scenario.tools, SUBMIT_RESULT, ...TOOL_REF_TOOLS, ...(o.projectRead ? [PROJECT_READ] : [])].join(","),
    ...(task.model ? ["--model", task.model] : []),
    ...(task.thinkingLevel ? ["--thinking", task.thinkingLevel] : []),
    `--${SCENARIO_FLAG}`, scenario.name,
    ...(o.projectDir ? [`--${PROJECT_FLAG}`, o.projectDir] : []),
    ...(task.tags?.length ? [`--${TAGS_FLAG}`, task.tags.join(",")] : []),
    "--", task.prompt,
  ];
}

/** Shell-quoted command line, for logs and for re-running a run by hand. */
export function shellQuote(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(" ");
}
