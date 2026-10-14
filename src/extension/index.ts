import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY, SCENARIO_CHANNEL, SUBMIT_INSTRUCTION, type ScenarioSelected } from "../shared/protocol.ts";
import { getScenario } from "../shared/scenarios/index.ts";
import { RunState } from "./run-state.ts";

/**
 * pi-agent runner extension. Inert until the scenario profile extension (src/scenario-profile/,
 * which owns `--scenario`) announces a scenario on SCENARIO_CHANNEL; then it registers
 * `submit_result`, adds SUBMIT_INSTRUCTION to the system prompt, sends the scenario's result
 * format after the task prompt, and nudges the model once if it stops without a result. The system prompt, tools and skills: the scenario
 * profile extension. Metrics: the metrics extension.
 *
 * Everything the wrapper needs ends up in pi's JSON event stream and session file, so the
 * extension keeps no state outside the process.
 */
export default function piAgentRunner(pi: ExtensionAPI) {
  let run: RunState | undefined;

  // Sent from the profile's session_start (flags are only parsed after extensions load), so the
  // tool is registered then and not in the factory. Tools registered at session start are
  // still subject to `--tools`.
  pi.events.on(SCENARIO_CHANNEL, (data) => {
    const { name } = data as ScenarioSelected;
    try {
      run = new RunState(getScenario(name));
    } catch (err) {
      // Not expected: the profile extension resolved the same name. Startup entries are not
      // streamed in --mode json, so also tell stderr (the wrapper keeps its tail).
      const message = (err as Error).message;
      console.error(`[pi-agent] ${message}`);
      pi.appendEntry(ENTRY.error, { message });
      return;
    }
    pi.registerTool(run.tool);
  });

  // The result format goes into the conversation (right after the task prompt), not into the
  // tool schema, so `submit_result` stays identical across scenarios. A resumed (forked)
  // session already has it.
  //
  // SUBMIT_INSTRUCTION goes into the system prompt on every prompt (pi rebuilds the options from
  // its base each time), after anything appended by configuration. The same for every scenario,
  // so it stays in the shared cached part of the prompt (block A).
  pi.on("before_agent_start", (event, ctx) => {
    if (!run) return;
    const options = event.systemPromptOptions;
    options.appendSystemPrompt = [options.appendSystemPrompt, SUBMIT_INSTRUCTION].filter(Boolean).join("\n\n");
    const sent = ctx.sessionManager
      .getBranch()
      .some((e) => e.type === "custom_message" && e.customType === ENTRY.resultFormat);
    if (sent) return;
    return { message: { customType: ENTRY.resultFormat, content: run.formatMessage, display: true } };
  });

  pi.on("agent_before_settle", (event) => run?.beforeSettle(event.outcome, event.entries));
}
