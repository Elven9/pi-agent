import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROJECT_CHANNEL,
  SCENARIO_CHANNEL,
  type ProjectAnnounced,
  type ScenarioSelected,
} from "../shared/protocol.ts";
import { isBuiltinTool } from "../scenario-profile/profile.ts";
import { formatContextView } from "./format.ts";

/** Session entries as far as this extension reads them. */
type BranchEntry = { type: string; message?: { role: string } };

/**
 * The system prompt the model has on the current branch, replayed from the session: pi
 * records the prompt as a system message when a run starts (sections, later patched by name).
 * Undefined before the first prompt (nothing recorded yet).
 */
export function sessionSystemPrompt(branch: readonly BranchEntry[]): string | undefined {
  const messages = branch.flatMap((e) => (e.type === "message" && e.message ? [e.message] : []));
  if (!messages.some((m) => m.role === "system")) return undefined;
  return getCurrentSystemPrompt(messages);
}

/**
 * Context view extension: `/context` shows what the session runs with: scenario, project,
 * active tools and the full system prompt (split at block B when a project adds one). Works in
 * every session; without `--scenario` and `--project` it shows pi's default setup.
 *
 * The scenario and project extensions announce themselves on SCENARIO_CHANNEL and
 * PROJECT_CHANNEL (pi's getFlag only reads an extension's own flags).
 *
 * The prompt comes from the session, where pi records what it sends (see sessionSystemPrompt),
 * so it is the model's prompt after any run and in resumed sessions. `ctx.getSystemPrompt()` is
 * not: extension changes (before_agent_start) only apply for the length of a run, after which
 * it returns pi's base prompt (default preamble, all loaded skills). Before the first prompt
 * nothing is recorded and pi exposes no way to build the effective prompt without a run, so the
 * command shows the base prompt and says so.
 */
export default function contextView(pi: ExtensionAPI) {
  let scenario: string | undefined;
  let project: ProjectAnnounced = { block: "" };

  // Not reset at session_start: these extensions may announce before our session_start runs.
  pi.events.on(SCENARIO_CHANNEL, (data) => void (scenario = (data as ScenarioSelected).name));
  pi.events.on(PROJECT_CHANNEL, (data) => void (project = data as ProjectAnnounced));

  pi.registerCommand("context", {
    description: "Show the context setup: scenario, project, tools and the full system prompt",
    handler: async (_args, ctx) => {
      const all = new Map(pi.getAllTools().map((t) => [t.name, t]));
      const sent = sessionSystemPrompt(ctx.sessionManager.getBranch() as readonly BranchEntry[]);
      const text = formatContextView({
        scenario,
        project: project.project,
        tools: pi.getActiveTools().map((name) => {
          const tool = all.get(name);
          return { name, builtin: tool ? isBuiltinTool(tool) : false };
        }),
        systemPrompt: sent ?? ctx.getSystemPrompt(),
        built: sent !== undefined,
        blockB: project.block,
      });
      ctx.ui.notify(text, "info");
    },
  });
}
