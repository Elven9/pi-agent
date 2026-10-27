import type { Metrics } from "./report.ts";

/**
 * Names shared by the wrapper and the extension. The wrapper starts pi with these flags and
 * reads these entries back from pi's JSON event stream (`entry_appended`) and session file.
 */

/**
 * Extension CLI flag selecting the scenario (`pi --scenario <name>`). Registered by the scenario
 * profile extension only (pi rejects a flag registered by two extensions); it announces the
 * scenario on SCENARIO_CHANNEL.
 */
export const SCENARIO_FLAG = "scenario";

/**
 * `pi.events` channel: the scenario profile extension emits `ScenarioSelected` at every session
 * start with a valid `--scenario`. The runner extension registers `submit_result` for it.
 */
export const SCENARIO_CHANNEL = "pi-agent.scenario";

export interface ScenarioSelected {
  name: string;
}

/**
 * Project extension CLI flag: folder with `project.yaml` (`pi --project <dir>`). Wins over the
 * remote project in settings.json (`project`, see project-source.ts).
 */
export const PROJECT_FLAG = "project";

/**
 * Tool the project extension registers to read a remote project's files (workflows, docs).
 * Active only with a remote project; the wrapper adds it to `--tools` then.
 */
export const PROJECT_READ = "project_read";

/**
 * `pi.events` channel: the project extension emits `ProjectAnnounced` at session start (after
 * loading) and on every prompt (once it knows whether block B is used). Read by the context view
 * extension (`/context`).
 */
export const PROJECT_CHANNEL = "pi-agent.project";

export interface ProjectAnnounced {
  /** The project manifest, if any. `dir`: its folder, or `<repo>@<tag>` for a remote project. */
  project?: { name: string; dir: string };
  /** Block B as it is in the system prompt; "" when not (yet) applied. */
  block: string;
  /**
   * Names of the prompt sections block B is made of (keys of pi's `SystemMessage.sections`),
   * announced also before a prompt applied them, so a recorded prompt (resumed session) can be
   * split. Optional: older announcements have none.
   */
  sections?: string[];
}

/**
 * `pi.events` channel: every pi-agent extension with a `message_end` handler that replaces
 * `toolResult` messages emits `ToolResultRewriterAnnounced` from its session_start. Such a
 * handler can drop tool-ref's trailer, so tool-ref must load after it: tool-ref listens, and an
 * announcement after its own session_start ran means that extension loaded later (error entry
 * and shutdown). No pi-agent extension rewrites tool results today; this guards future ones.
 */
export const TOOL_RESULT_REWRITER_CHANNEL = "pi-agent.tool-result-rewriter";

export interface ToolResultRewriterAnnounced {
  /** Extension name, for the error message. */
  name: string;
}

/** Tool the agent calls with its final result. Its `details` are a `SubmittedResult`. */
export const SUBMIT_RESULT = "submit_result";

/**
 * Added by the runner extension to every scenario's system prompt (pi's `appendSystemPrompt`,
 * the `<addendum>` right after the scenario prompt), so scenario prompts don't repeat it.
 */
export const SUBMIT_INSTRUCTION =
  "When you are done, call the submit_result tool exactly once with your final result.";

/** Sent once (as a custom message) when the agent stops without a valid `submit_result`. */
export const RESUBMIT_PROMPT =
  "You have not submitted a valid result yet. Call the submit_result tool now with your final result.";

/** Custom entry/message types written by the extension. */
export const ENTRY = {
  /** `custom_message` with the scenario's result format, sent once after the task prompt. */
  resultFormat: "pi-agent.result-format",
  /** `custom_message` with RESUBMIT_PROMPT. */
  resubmit: "pi-agent.resubmit",
  /** `custom` entry with `SessionMetricsEntry` data (metrics extension), appended when the agent settles. */
  metrics: "pi-agent.metrics",
  /** `custom` entry with `{ message }` when an extension cannot run (scenario, project, load order). */
  error: "pi-agent.error",
} as const;

/** `pi.events` channel: the metrics extension appends a `pi-agent.metrics` entry now (if changed). */
export const METRICS_FLUSH_CHANNEL = "pi-agent.metrics.flush";

export const METRICS_ENTRY_VERSION = 1;

/** Raw samples (ms, rounded) recorded since the previous metrics entry on the branch. */
export interface MetricsSamples {
  ttftMs: number[];
  latencyMs: number[];
  toolMs: Record<string, number[]>;
}

/**
 * Data of a `pi-agent.metrics` entry. The metrics are cumulative for the session branch (across
 * resumes): the newest entry on a branch is its total. Process-level metrics (`wallMs`,
 * `phases`) and `retries` (not visible to extensions) are only in report.json.
 *
 * `samples` holds only what is new since the previous entry, so entries stay small; all entries
 * of a branch together give every sample, from which the percentiles are recomputed on resume.
 */
export interface SessionMetricsEntry extends Omit<Metrics, "wallMs" | "phases" | "retries"> {
  version: typeof METRICS_ENTRY_VERSION;
  samples: MetricsSamples;
}
