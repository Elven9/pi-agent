import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY, SCENARIO_FLAG } from "../shared/protocol.ts";
import { getScenario } from "../shared/scenarios/index.ts";
import { RunState } from "./run-state.ts";

/**
 * pi-agent runner extension. Inert unless pi is started with `--scenario <name>`; then it
 * registers `submit_result`, sends the scenario's result format after the task prompt, nudges
 * the model once if it stops without a result, and records metrics pi does not stream (context
 * usage peak).
 *
 * Everything the wrapper needs ends up in pi's JSON event stream and session file, so the
 * extension keeps no state outside the process.
 */
export default function piAgentRunner(pi: ExtensionAPI) {
  pi.registerFlag(SCENARIO_FLAG, {
    type: "string",
    description: "pi-agent scenario to run (registers submit_result for it)",
  });

  let run: RunState | undefined;

  // Flags are only parsed after extensions load, so the tool is registered here and not in
  // the factory. Tools registered at session start are still subject to `--tools`.
  pi.on("session_start", (_event, ctx) => {
    const name = pi.getFlag(SCENARIO_FLAG);
    if (typeof name !== "string" || name === "") return;
    try {
      run = new RunState(getScenario(name));
    } catch (err) {
      // Startup entries are not streamed in --mode json, so also tell stderr (the wrapper
      // keeps its tail).
      const message = (err as Error).message;
      console.error(`[pi-agent] ${message}`);
      pi.appendEntry(ENTRY.error, { message });
      ctx.shutdown();
      return;
    }
    pi.registerTool(run.tool);
  });

  // The result format goes into the conversation (right after the task prompt), not into the
  // tool schema, so `submit_result` stays identical across scenarios. A resumed (forked)
  // session already has it.
  pi.on("before_agent_start", (_event, ctx) => {
    if (!run) return;
    const sent = ctx.sessionManager
      .getBranch()
      .some((e) => e.type === "custom_message" && e.customType === ENTRY.resultFormat);
    if (sent) return;
    return { message: { customType: ENTRY.resultFormat, content: run.formatMessage, display: true } };
  });

  pi.on("message_end", (event, ctx) => {
    if (run && event.message.role === "assistant") run.sampleContext(ctx.getContextUsage()?.percent);
  });

  pi.on("session_compact", (_event, ctx) => {
    run?.sampleContext(ctx.getContextUsage()?.percent);
  });

  pi.on("agent_before_settle", (event) => run?.beforeSettle(event.outcome));
}
