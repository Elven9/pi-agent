import type { Metrics } from "./report.ts";

/**
 * Names shared by the wrapper and the extension. The wrapper starts pi with these flags and
 * reads these entries back from pi's JSON event stream (`entry_appended`) and session file.
 */

/** Extension CLI flag selecting the scenario (`pi --scenario <name>`). */
export const SCENARIO_FLAG = "scenario";

/** Project extension CLI flag: folder with `project.yaml` (`pi --project <dir>`). */
export const PROJECT_FLAG = "project";

/** Tool the agent calls with its final result. Its `details` are a `SubmittedResult`. */
export const SUBMIT_RESULT = "submit_result";

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
