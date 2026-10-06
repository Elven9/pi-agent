/**
 * Names shared by the wrapper and the extension. The wrapper starts pi with these flags and
 * reads these entries back from pi's JSON event stream (`entry_appended`) and session file.
 */

/** Extension CLI flag selecting the scenario (`pi --scenario <name>`). */
export const SCENARIO_FLAG = "scenario";

/** Tool the agent calls with its final result. Its `details` are a `SubmittedResult`. */
export const SUBMIT_RESULT = "submit_result";

/** Sent once (as a custom message) when the agent stops without a valid `submit_result`. */
export const RESUBMIT_PROMPT =
  "You have not submitted a valid result yet. Call the submit_result tool now with your final result.";

/** Custom entry/message types written by the extension. */
export const ENTRY = {
  /** `custom_message` with RESUBMIT_PROMPT. */
  resubmit: "pi-agent.resubmit",
  /** `custom` entry with `RunMetricsEntry` data, appended when the agent settles. */
  metrics: "pi-agent.metrics",
  /** `custom` entry with `{ message }` when the extension cannot run the scenario. */
  error: "pi-agent.error",
} as const;

/** Measurements only the extension can take (pi does not stream them). */
export interface RunMetricsEntry {
  /** Highest context usage seen after a model response or compaction, 0-100; null if unknown. */
  contextPeakPercent: number | null;
}
