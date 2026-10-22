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

/** Project extension CLI flag: folder with `project.yaml` (`pi --project <dir>`). */
export const PROJECT_FLAG = "project";

/**
 * `pi.events` channel: the project extension emits `ProjectAnnounced` at session start (after
 * loading) and on every prompt (once it knows whether block B is used). Read by the context view
 * extension (`/context`).
 */
export const PROJECT_CHANNEL = "pi-agent.project";

export interface ProjectAnnounced {
  /** The `--project` manifest, if any. */
  project?: { name: string; dir: string };
  /** Block B as it is in the system prompt; "" when not (yet) applied. */
  block: string;
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
  /** `custom` entry with `{ message }` when an extension cannot run (scenario or project). */
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
