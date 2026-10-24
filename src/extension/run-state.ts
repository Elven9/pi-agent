import type { BoundaryResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ENTRY, RESUBMIT_PROMPT, SUBMIT_RESULT } from "../shared/protocol.ts";
import {
  detailErrors,
  resultFormatMessage,
  SUBMIT_PARAMETERS,
  type SubmittedResult,
} from "../shared/result.ts";
import type { Scenario } from "../shared/scenarios/index.ts";

type Outcome = "completed" | "aborted" | "error";

/**
 * Per-session state of a scenario run: the `submit_result` tool and the one-time resubmit
 * nudge. Metrics come from the metrics extension.
 */
export class RunState {
  readonly tool: ToolDefinition;
  /** Detail format for the model, sent once after the task prompt. */
  readonly formatMessage: string;
  private last?: SubmittedResult;
  private nudged = false;

  constructor(scenario: Scenario) {
    this.formatMessage = resultFormatMessage(scenario);
    // Same definition in every scenario: tools are the start of the cached prompt prefix.
    this.tool = {
      name: SUBMIT_RESULT,
      label: "Submit Result",
      description:
        "Submit the final result of the task. Call it once when you are done; calling it again replaces the previous result.",
      parameters: SUBMIT_PARAMETERS,
      // Declared to the model in every codemode mode ("only" hides direct tools) and not
      // callable from scripts: the result is the model's own final call.
      exposure: "model-only",
      execute: async (_toolCallId, params: { summary: string; detail: unknown }) => {
        // pi has validated the envelope; the scenario's detail is checked here. Throwing makes
        // this a failed tool result, so the model sees the errors and can call again.
        const errors = detailErrors(scenario, params.detail);
        if (errors.length) {
          throw new Error(`Invalid result:\n${errors.join("\n")}\nFix detail to match the result format and call submit_result again.`);
        }
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

  /**
   * `agent_before_settle`: without a valid result, ask the model once more (one extra model
   * request). `proposed` are the entries earlier handlers proposed; returned entries replace
   * them, so they are kept.
   */
  beforeSettle(outcome: Outcome, proposed: BoundaryResult["entries"] = []): BoundaryResult | undefined {
    if (this.last || this.nudged || outcome !== "completed") return undefined;
    this.nudged = true;
    return {
      entries: [
        ...(proposed ?? []),
        { type: "custom_message", customType: ENTRY.resubmit, content: RESUBMIT_PROMPT, display: true },
      ],
      continue: true,
    };
  }
}
