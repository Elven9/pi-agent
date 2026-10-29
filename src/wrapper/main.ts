import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getScenario, scenarioNames } from "../shared/scenarios/index.ts";
import { loadTask } from "../shared/task.ts";
import { resolveProject } from "./project-input.ts";
import { writeReport } from "./report-file.ts";
import { loadPreviousSession } from "./resume.ts";
import { runTask, type RunOptions } from "./run.ts";
import { resolveSkills, withExternalSkills } from "./skills.ts";

const EXIT_OK = 0; // report.json written (whatever its status)
const EXIT_CRASH = 1; // wrapper crashed; no reliable report
const EXIT_INPUT = 2; // invalid input

const USAGE =
  "usage: pi-agent run --task task.json [--workdir dir] [--out dir] [--resume session.jsonl] [--project dir]";

/**
 * Where the extensions and the app root (with skills/) are. Bundled: dist/pi-agent.js next to
 * dist/extension.js, dist/scenario-profile.js, dist/project.js, dist/metrics.js and dist/tool-ref.js. From source
 * (node src/wrapper/main.ts): pi loads the .ts extensions, which import .md files, so pi needs the same loader hook as `npm run dev`.
 */
function locate(): {
  extensionPath: string;
  scenarioProfileExtensionPath: string;
  projectExtensionPath: string;
  metricsExtensionPath: string;
  toolRefExtensionPath: string;
  rootDir: string;
} {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "extension.js");
  if (existsSync(bundled)) {
    return {
      extensionPath: bundled,
      scenarioProfileExtensionPath: join(here, "scenario-profile.js"),
      projectExtensionPath: join(here, "project.js"),
      metricsExtensionPath: join(here, "metrics.js"),
      toolRefExtensionPath: join(here, "tool-ref.js"),
      rootDir: dirname(here),
    };
  }
  // Inherited by pi (and so by the commands its bash tool runs; source runs only).
  const hook = `--import=${pathToFileURL(resolve(here, "../../scripts/md-loader.mjs")).href}`;
  if (!process.env.NODE_OPTIONS?.includes(hook)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, hook].filter(Boolean).join(" ");
  }
  return {
    extensionPath: join(here, "../extension/index.ts"),
    scenarioProfileExtensionPath: join(here, "../scenario-profile/index.ts"),
    projectExtensionPath: join(here, "../project/index.ts"),
    metricsExtensionPath: join(here, "../metrics/index.ts"),
    toolRefExtensionPath: join(here, "../tool-ref/index.ts"),
    rootDir: resolve(here, "../.."),
  };
}

async function parseInput(argv: string[]): Promise<Omit<RunOptions, "signal" | "log">> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      workdir: { type: "string" },
      out: { type: "string" },
      resume: { type: "string" },
      project: { type: "string" },
    },
    allowPositionals: true,
    strict: true, // unknown flags are an error
  });
  // The "run" subcommand is optional; anything else is an error.
  if (positionals.length > 1 || (positionals[0] !== undefined && positionals[0] !== "run")) {
    throw new Error(`Unknown command: ${positionals.join(" ")}`);
  }
  if (!values.task) throw new Error("--task is required");

  // pi records the real path as the session cwd (e.g. /private/tmp on macOS).
  const workdir = await realpath(resolve(values.workdir ?? process.cwd())).catch(() => {
    throw new Error(`Workdir ${values.workdir} does not exist`);
  });
  const out = resolve(values.out ?? `${workdir}/.agent-out`);
  const task = await loadTask(values.task);
  const scenario = getScenario(task.scenario);
  const resume = values.resume ? await loadPreviousSession(resolve(values.resume)) : undefined;
  const { project, warnings } = await resolveProject({ flag: values.project, workdir });
  const { rootDir, ...extensions } = locate();
  const skillPaths = withExternalSkills(
    await resolveSkills(join(rootDir, "skills"), scenario.name, scenarioNames()),
    scenario.externalSkills?.include,
  );
  return {
    task, scenario, workdir, out, resume, project, warnings, skillPaths,
    piBin: process.env.PI_AGENT_PI_BIN || "pi",
    ...extensions,
  };
}

let input: Awaited<ReturnType<typeof parseInput>>;
try {
  input = await parseInput(process.argv.slice(2));
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`);
  process.exit(EXIT_INPUT);
}

// SIGINT/SIGTERM stop pi but still produce a report (status "error"). A second one exits now.
const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (controller.signal.aborted) process.exit(EXIT_CRASH);
    console.error(`\n[pi-agent] ${sig}: stopping pi`);
    controller.abort();
  });
}

try {
  const report = await runTask({ ...input, signal: controller.signal });
  const path = await writeReport(input.out, report);
  console.error(`[pi-agent] status=${report.status} report=${path}`);
  console.log(path);
  process.exit(EXIT_OK);
} catch (err) {
  console.error(`[pi-agent] crashed: ${(err as Error).stack ?? err}`);
  process.exit(EXIT_CRASH);
}
