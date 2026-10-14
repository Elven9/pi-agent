import { mkdir, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  describeBlock,
  PROJECT_TOKEN_WARNING,
  readAgentsMd,
  renderProjectSections,
  type Project,
} from "../shared/project.ts";
import {
  REPORT_VERSION,
  type ProjectContextInfo,
  type Report,
  type RunnerError,
  type RunStatus,
} from "../shared/report.ts";
import { validateResult, type SubmittedResult } from "../shared/result.ts";
import type { Scenario } from "../shared/scenarios/index.ts";
import type { Task } from "../shared/task.ts";
import type { RecordSink, StreamRecord } from "./events.ts";
import { MetricsCollector } from "../shared/metrics.ts";
import { RunOutcome } from "./outcome.ts";
import { piArgs, shellQuote } from "./pi-command.ts";
import { clearReport } from "./report-file.ts";
import { checkResume, type PreviousSession } from "./resume.ts";
import { runPi } from "./run-pi.ts";
import { ToolLog } from "./tool-log.ts";

export interface RunOptions {
  task: Task;
  scenario: Scenario;
  workdir: string;
  out: string;
  resume?: PreviousSession;
  /** Validated project manifest (`--project`). */
  project?: Project;
  /** Warnings found while reading the input (e.g. no project.yaml at the default path). */
  warnings?: string[];
  /** pi executable. */
  piBin: string;
  extensionPath: string;
  /** Bundled scenario profile extension (dist/scenario-profile.js). */
  scenarioProfileExtensionPath: string;
  projectExtensionPath: string;
  /** Bundled metrics extension (dist/metrics.js). */
  metricsExtensionPath: string;
  /** Skill directories to load (absolute), see resolveSkills. */
  skillPaths: string[];
  /** Aborting stops pi; the report then has status "error". */
  signal?: AbortSignal;
  /** Diagnostics and progress (default: stderr). */
  log?: (text: string) => void;
}

/** Path for the report: relative to `out` when inside it, else absolute. */
function outPath(out: string, path: string): string {
  const rel = relative(out, path);
  return rel.startsWith("..") ? path : rel;
}

function tail(text: string, lines = 10): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/** pi names session files `<timestamp>_<id>.jsonl`. */
async function findSessionFile(dir: string, id: string): Promise<string | null> {
  const name = (await readdir(dir).catch(() => [])).find((f) => f.endsWith(`_${id}.jsonl`));
  return name ? join(dir, name) : null;
}

/**
 * Block B as the project extension will render it (same shared code and inputs), for the
 * report: its hash shows whether the cached project prefix changed between runs.
 */
async function projectContext(project: Project | undefined, workdir: string): Promise<ProjectContextInfo | null> {
  const sections = renderProjectSections({ cwd: workdir, project, agentsMd: await readAgentsMd(workdir) });
  if (Object.keys(sections).length === 0) return null;
  return { dir: project?.dir ?? null, name: project?.manifest.name ?? null, ...describeBlock(sections) };
}

/** Streams assistant text and tool names, for humans. */
function progress(log: (text: string) => void): RecordSink {
  return {
    onRecord(r: StreamRecord) {
      if (r.type === "message_update" && r.assistantMessageEvent.type === "text_delta") {
        log(r.assistantMessageEvent.delta);
      } else if (r.type === "tool_execution_start") {
        log(`\n[tool] ${r.toolName}\n`);
      }
    },
  };
}

/**
 * Runs one task: starts pi for the scenario, follows its JSON event stream, and builds the
 * report. Does not write the report (the caller does, last).
 */
export async function runTask(o: RunOptions): Promise<Report> {
  const { task, scenario, workdir, out, resume } = o;
  const log = o.log ?? ((text: string) => void process.stderr.write(text));
  const startedAt = new Date();
  const errors: RunnerError[] = [];
  const warnings: string[] = [...(o.warnings ?? [])];
  const metrics = new MetricsCollector();
  const toolLog = new ToolLog();
  const outcome = new RunOutcome();
  metrics.phase("setup");

  await clearReport(out);
  if (resume) warnings.push(...checkResume(resume, workdir));
  const context = await projectContext(o.project, workdir);
  if (context && context.approxTokens > PROJECT_TOKEN_WARNING) {
    warnings.push(
      `project context is ~${context.approxTokens} tokens (over ${PROJECT_TOKEN_WARNING}); it is re-read on every turn`,
    );
  }
  for (const w of warnings) log(`[pi-agent] warning: ${w}\n`);

  const sessionDir = join(out, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const args = piArgs({
    task,
    scenario,
    extensionPath: o.extensionPath,
    scenarioProfileExtensionPath: o.scenarioProfileExtensionPath,
    projectExtensionPath: o.projectExtensionPath,
    metricsExtensionPath: o.metricsExtensionPath,
    projectDir: o.project?.dir,
    skillPaths: o.skillPaths,
    sessionDir,
    resumeFrom: resume?.sessionPath,
  });
  const projectNote = context ? ` project=${context.name ?? "(AGENTS.md only)"} block=${context.sha256.slice(0, 12)}` : "";
  log(`[pi-agent] task=${task.taskId} scenario=${scenario.name}${projectNote}\n[pi-agent] ${shellQuote([o.piBin, ...args])}\n`);

  const sinks: RecordSink[] = [outcome, metrics, toolLog, progress(log)];
  const exit = await runPi({
    bin: o.piBin,
    args,
    cwd: workdir,
    signal: o.signal,
    onRecord(record) {
      if (record.type === "agent_start" && metrics.currentPhase === "setup") metrics.phase("run");
      for (const sink of sinks) sink.onRecord(record, performance.now());
    },
  });
  log("\n");
  metrics.phase("validate");

  let failed = false;
  const fail = (phase: string, message: string) => {
    errors.push({ phase, message });
    failed = true;
  };
  const phase = outcome.started ? "run" : "setup";
  const stderr = tail(exit.stderrTail);
  if (exit.spawnError) {
    fail("setup", exit.spawnError);
  } else if (o.signal?.aborted) {
    fail(phase, "interrupted; pi was stopped");
  } else if (exit.code !== 0) {
    fail(phase, `pi exited with ${exit.signal ?? `code ${exit.code}`}${stderr && `: ${stderr}`}`);
  } else if (!outcome.started) {
    fail("setup", `pi exited before the agent started${stderr && `: ${stderr}`}`);
  }
  for (const message of outcome.extensionErrors) fail(phase, message);
  if (outcome.modelError) {
    errors.push({ phase: "run", message: outcome.modelError });
    if (outcome.result === undefined) failed = true;
  }
  if (exit.badLines) warnings.push(`${exit.badLines} line(s) of pi's output were not valid JSON`);

  if (outcome.result !== undefined) {
    const problems = validateResult(scenario, outcome.result);
    if (problems.length) fail("validate", `submitted result is invalid: ${problems.join("; ")}`);
  }
  metrics.endPhase();

  const status: RunStatus = failed ? "error" : outcome.result !== undefined ? "ok" : "no_result";
  const header = outcome.header;
  const sessionFile = header ? await findSessionFile(sessionDir, header.id) : null;
  return {
    reportVersion: REPORT_VERSION,
    taskId: task.taskId,
    scenario: scenario.name,
    status,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    result: (outcome.result as SubmittedResult | undefined) ?? null,
    metrics: metrics.snapshot(),
    projectContext: context,
    toolCalls: toolLog.entries(),
    session: header
      ? {
          id: header.id,
          file: sessionFile ? outPath(out, sessionFile) : null,
          ...(resume && { resumedFrom: outPath(out, resume.sessionPath) }),
        }
      : null,
    errors,
    warnings,
  };
}
