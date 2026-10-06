import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY, SCENARIO_FLAG } from "../shared/protocol.ts";
import { getScenario } from "../shared/scenarios/index.ts";
import { RunState } from "./run-state.ts";

/**
 * pi-agent runner extension. Inert unless pi is started with `--scenario <name>`; then it
 * registers `submit_result` for that scenario, nudges the model once if it stops without a
 * result, and records metrics pi does not stream (context usage peak).
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
      pi.appendEntry(ENTRY.error, { message: (err as Error).message });
      ctx.shutdown();
      return;
    }
    pi.registerTool(run.tool);
  });

  pi.on("message_end", (event, ctx) => {
    if (run && event.message.role === "assistant") run.sampleContext(ctx.getContextUsage()?.percent);
  });

  pi.on("session_compact", (_event, ctx) => {
    run?.sampleContext(ctx.getContextUsage()?.percent);
  });

  pi.on("agent_before_settle", (event) => run?.beforeSettle(event.outcome));
}
