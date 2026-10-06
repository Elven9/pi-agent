import type { BoundaryResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ENTRY, RESUBMIT_PROMPT, SUBMIT_RESULT, type RunMetricsEntry } from "../shared/protocol.ts";
import { resultSchema, schemaErrors, type SubmittedResult } from "../shared/result.ts";
import type { Scenario } from "../shared/scenarios/index.ts";

type Outcome = "completed" | "aborted" | "error";

/**
 * Per-session state of a scenario run: the `submit_result` tool, the one-time resubmit nudge,
 * and the context-usage peak.
 */
export class RunState {
  readonly tool: ToolDefinition;
  private last?: SubmittedResult;
  private nudged = false;
  private contextPeak: number | null = null;

  constructor(scenario: Scenario) {
    const schema = resultSchema(scenario);
    this.tool = {
      name: SUBMIT_RESULT,
      label: "Submit Result",
      description:
        "Submit the final result of the task. Call it once when you are done; calling it again replaces the previous result.",
      parameters: schema,
      execute: async (_toolCallId, params: { summary: string; detail: unknown }) => {
        // Defensive re-check; pi has already validated the arguments against `schema`.
        const errors = schemaErrors(schema, params);
        if (errors.length) throw new Error(`Invalid result:\n${errors.join("\n")}`);
        this.last = { summary: params.summary, detailKind: scenario.detailKind, detail: params.detail };
        return {
          content: [{ type: "text", text: "Result recorded." }],
          // The wrapper reads the result from here (tool_execution_end / session file).
          details: this.last,
          // Done: skip the follow-up model request after this tool batch.
          terminate: true,
        };
      },
    } as ToolDefinition;
  }

  /** Last valid submission, if any. */
  get result(): SubmittedResult | undefined {
    return this.last;
  }

  sampleContext(percent: number | null | undefined): void {
    if (percent != null) this.contextPeak = Math.max(this.contextPeak ?? 0, percent);
  }

  /**
   * `agent_before_settle`: without a valid result, ask the model once more (one extra model
   * request). Otherwise record the run's metrics; pi will not continue after this.
   */
  beforeSettle(outcome: Outcome): BoundaryResult {
    if (!this.last && !this.nudged && outcome === "completed") {
      this.nudged = true;
      return {
        entries: [{ type: "custom_message", customType: ENTRY.resubmit, content: RESUBMIT_PROMPT, display: true }],
        continue: true,
      };
    }
    const data: RunMetricsEntry = {
      contextPeakPercent: this.contextPeak === null ? null : Math.round(this.contextPeak),
    };
    return { entries: [{ type: "custom", customType: ENTRY.metrics, data }] };
  }
}
