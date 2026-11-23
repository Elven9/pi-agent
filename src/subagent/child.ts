import { createCodemodeExtension, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { SCENARIO_CHANNEL, type ScenarioSelected } from "../shared/protocol.ts";
import { detailErrors } from "../shared/result.ts";
import { getScenario, type Scenario } from "../shared/scenarios/index.ts";
import { type ResultBody, SEND_TO_LEADER } from "./protocol.ts";

const PARAMETERS = Type.Object({
  status: Type.Unsafe<"ok" | "error">({
    type: "string",
    enum: ["ok", "error"],
    description: '"ok" when the task is done, "error" when you could not do it',
  }),
  summary: Type.String({ description: "The outcome in a few sentences; the leader reads it first" }),
  detail: Type.Optional(
    Type.Object(
      {},
      { additionalProperties: true, description: "Structured result; must follow the result format given in the task" },
    ),
  ),
});

/**
 * Child side of the subagent extension (process started with PI_AGENT_SUBAGENT=1): only
 * `send_to_leader`, no leader tools, commands or UI, so a child cannot spawn children. The leader
 * reads the result from the tool's `details.body` in the child's RPC event stream
 * (`tool_execution_end`). `detail` is checked against the scenario's detail schema when the
 * scenario is known (SCENARIO_CHANNEL from the scenario profile extension).
 *
 * Children are codemode-only whatever the user's `codemode.mode` setting: registering a `codemode`
 * tool while loading replaces pi's (replaceable) built-in codemode extension, and ours runs with
 * `mode: "only"`, so the other active tools are reached through scripts. `send_to_leader` is
 * `model-only` (never script-callable), so it stays declared. Whether `codemode` is active is still
 * up to the scenario's tools (`--tools +codemode` for a general child, see childArgs).
 */
export function registerChild(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "only" })(pi);
  let scenario: Scenario | undefined;
  pi.events.on(SCENARIO_CHANNEL, (data) => {
    try {
      scenario = getScenario((data as ScenarioSelected).name);
    } catch {
      scenario = undefined;
    }
  });

  pi.registerTool({
    name: SEND_TO_LEADER,
    label: "Send to leader",
    description:
      "Send the result of your task to the leader that started you. Call it exactly once, when you are done; the leader cannot answer questions.",
    parameters: PARAMETERS,
    exposure: "model-only",
    async execute(_id, params: { status: "ok" | "error"; summary: string; detail?: unknown }) {
      if (params.detail !== undefined && scenario) {
        const errors = detailErrors(scenario, params.detail);
        if (errors.length) {
          throw new Error(`Invalid detail:\n${errors.join("\n")}\nFix detail to match the result format and call ${SEND_TO_LEADER} again.`);
        }
      }
      const body: ResultBody = {
        status: params.status,
        summary: params.summary,
        ...(params.detail !== undefined && { detail: params.detail, ...(scenario && { detailKind: scenario.detailKind }) }),
      };
      return {
        content: [{ type: "text", text: "Sent to the leader." }],
        details: { body },
        // Done: no further model request after this tool batch.
        terminate: true,
      };
    },
  } as ToolDefinition<TSchema>);
}
