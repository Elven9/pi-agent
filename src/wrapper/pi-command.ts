import { resolve } from "node:path";
import { PROJECT_FLAG, SCENARIO_FLAG, SUBMIT_RESULT } from "../shared/protocol.ts";
import type { Scenario } from "../shared/scenarios/index.ts";
import type { Task } from "../shared/task.ts";

export interface PiCommandOptions {
  task: Task;
  scenario: Scenario;
  /** Bundled runner extension (dist/extension.js). */
  extensionPath: string;
  /** Bundled project context extension (dist/project.js). Always loaded: it also adds AGENTS.md. */
  projectExtensionPath: string;
  /** Folder with a validated project.yaml. */
  projectDir?: string;
  /** Repo/app root; scenario skill paths are relative to it. */
  rootDir: string;
  sessionDir: string;
  /** Previous session file to fork from. */
  resumeFrom?: string;
}

/**
 * pi CLI arguments for one scenario run. Loads nothing implicitly: no discovered extensions,
 * skills, prompt templates, context files, themes, MCP or project config (the workdir is not
 * trusted). Only the runner and project extensions, the scenario's skills and tools. Context
 * files (AGENTS.md) come from the project extension, after skills, not from pi (`-nc`).
 */
export function piArgs(o: PiCommandOptions): string[] {
  const { task, scenario } = o;
  return [
    "--mode", "json",
    "-ne", "-e", o.extensionPath, "-e", o.projectExtensionPath,
    "--no-mcp",
    "-ns", ...(scenario.skillPaths ?? []).flatMap((p) => ["--skill", resolve(o.rootDir, p)]),
    "-np",
    "-nc",
    "--no-themes",
    "-na",
    "--offline",
    "--session-dir", o.sessionDir,
    ...(o.resumeFrom ? ["--fork", o.resumeFrom] : []),
    "--tools", [...scenario.tools, SUBMIT_RESULT].join(","),
    ...(task.model ? ["--model", task.model] : []),
    ...(task.thinkingLevel ? ["--thinking", task.thinkingLevel] : []),
    "--system-prompt", scenario.systemPrompt,
    `--${SCENARIO_FLAG}`, scenario.name,
    ...(o.projectDir ? [`--${PROJECT_FLAG}`, o.projectDir] : []),
    "--", task.prompt,
  ];
}

/** Shell-quoted command line, for logs and for re-running a run by hand. */
export function shellQuote(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(" ");
}
