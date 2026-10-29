import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject, loadProjectFrom, PROJECT_FILE, type Project } from "../shared/project.ts";
import { execCli, projectSetting, settingSource, type CliRunner } from "../shared/project-source.ts";

/**
 * pi's settings.json in the agent dir, the only settings pi reads in a run (the workdir is not
 * trusted, so no project settings). Empty when there is none.
 */
export async function agentSettings(env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const dir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const file = join(dir, "settings.json");
  const text = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${file}: ${err.message}`);
  });
  if (text === undefined) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid ${file}: ${(err as Error).message}`);
  }
}

export interface ProjectInput {
  /** `--project`, resolved against the wrapper's cwd. */
  flag?: string;
  /** Where pi runs: a relative `dir` in a `local` settings entry is resolved against it. */
  workdir: string;
  env?: NodeJS.ProcessEnv;
  /** Runs gh/glab (tests replace it). */
  run?: CliRunner;
}

/**
 * In order:
 * 1. `--project`: must point to a valid manifest.
 * 2. `PI_AGENT_PROJECT`, a default folder (the image sets /project): used when it has a
 *    `project.yaml`. Without one it doesn't count, so the settings entry still applies.
 * 3. The `project` entry in the agent dir's settings.json (`local`, `github` or `gitlab`):
 *    must open and be valid. A local one is passed to pi as `--project`; for a remote one pi
 *    gets no `--project` and the extension reads the same entry.
 * Nothing found: no project context, with a warning when `PI_AGENT_PROJECT` was set. An
 * invalid manifest is an error in every case.
 */
export async function resolveProject(input: ProjectInput): Promise<{ project: Project | undefined; warnings: string[] }> {
  const { flag, workdir, env = process.env, run = execCli } = input;
  if (flag !== undefined) return { project: await loadProject(resolve(flag)), warnings: [] };
  const envDir = env.PI_AGENT_PROJECT ? resolve(env.PI_AGENT_PROJECT) : undefined;
  const fromEnv = envDir ? await loadProject(envDir, { optional: true }) : undefined;
  if (fromEnv) return { project: fromEnv, warnings: [] };
  const setting = projectSetting(await agentSettings(env));
  if (setting) return { project: await loadProjectFrom(await settingSource(setting, workdir, run)), warnings: [] };
  const warnings = envDir ? [`no ${PROJECT_FILE} in ${envDir} (PI_AGENT_PROJECT); running without project context`] : [];
  return { project: undefined, warnings };
}
