import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getScenario } from "../shared/scenarios/index.ts";
import { loadTask } from "../shared/task.ts";
import { writeReport } from "./report-file.ts";
import { loadPreviousSession } from "./resume.ts";
import { runTask, type RunOptions } from "./run.ts";

const EXIT_OK = 0; // report.json written (whatever its status)
const EXIT_CRASH = 1; // wrapper crashed; no reliable report
const EXIT_INPUT = 2; // invalid input

const USAGE = "usage: pi-agent run --task task.json [--workdir dir] [--out dir] [--resume session.jsonl]";

/**
 * Where the extension and the app root are. Bundled: dist/pi-agent.js next to
 * dist/extension.js. From source (node src/wrapper/main.ts): pi loads the .ts extension.
 */
function locate(): { extensionPath: string; rootDir: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "extension.js");
  if (existsSync(bundled)) return { extensionPath: bundled, rootDir: dirname(here) };
  return { extensionPath: join(here, "../extension/index.ts"), rootDir: resolve(here, "../..") };
}

async function parseInput(argv: string[]): Promise<Omit<RunOptions, "signal" | "log">> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      workdir: { type: "string" },
      out: { type: "string" },
      resume: { type: "string" },
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
  return { task, scenario, workdir, out, resume, piBin: process.env.PI_AGENT_PI_BIN || "pi", ...locate() };
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
