import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROJECT_CHANNEL,
  SCENARIO_CHANNEL,
  type ProjectAnnounced,
  type ScenarioSelected,
} from "../shared/protocol.ts";
import { isBuiltinTool } from "../scenario-profile/profile.ts";
import { formatContextView } from "./format.ts";

/**
 * Context view extension: `/context` shows what the session runs with: scenario, project,
 * active tools and the full system prompt (split at block B when a project adds one). Works in
 * every session; without `--scenario` and `--project` it shows pi's default setup.
 *
 * The scenario and project extensions announce themselves on SCENARIO_CHANNEL and
 * PROJECT_CHANNEL (pi's getFlag only reads an extension's own flags). pi applies extension
 * changes to the prompt when a prompt starts and does not export its prompt builder, so before
 * the first prompt the command shows pi's base prompt and says so.
 */
export default function contextView(pi: ExtensionAPI) {
  let scenario: string | undefined;
  let project: ProjectAnnounced = { block: "" };
  /** Whether a prompt ran in this session, so pi's system prompt includes extension changes. */
  let built = false;

  // Not reset at session_start: these extensions may announce before our session_start runs.
  pi.events.on(SCENARIO_CHANNEL, (data) => void (scenario = (data as ScenarioSelected).name));
  pi.events.on(PROJECT_CHANNEL, (data) => void (project = data as ProjectAnnounced));

  pi.on("session_start", () => void (built = false));
  pi.on("before_agent_start", () => void (built = true));

  pi.registerCommand("context", {
    description: "Show the context setup: scenario, project, tools and the full system prompt",
    handler: async (_args, ctx) => {
      const all = new Map(pi.getAllTools().map((t) => [t.name, t]));
      const text = formatContextView({
        scenario,
        project: project.project,
        tools: pi.getActiveTools().map((name) => {
          const tool = all.get(name);
          return { name, builtin: tool ? isBuiltinTool(tool) : false };
        }),
        systemPrompt: ctx.getSystemPrompt(),
        built,
        blockB: project.block,
      });
      ctx.ui.notify(text, "info");
    },
  });
}
