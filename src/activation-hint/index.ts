import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROJECT_CHANNEL,
  SCENARIO_CHANNEL,
  type ProjectAnnounced,
  type ScenarioSelected,
} from "../shared/protocol.ts";

/**
 * Activation hint (personal pi, TUI only). After session start, if a scenario (`--scenario`) or
 * a project (`--project` or settings.json) is active, shows one info notification saying so.
 * pi's built-in header is left as it is.
 *
 * Both are announced from the session_start of the scenario-profile and project extensions, so
 * this extension must load after them: pi runs session_start handlers in load order, each
 * awaited before the next.
 */
export default function activationHint(pi: ExtensionAPI) {
  let scenario: string | undefined;
  let project: ProjectAnnounced["project"];

  pi.events.on(SCENARIO_CHANNEL, (data) => {
    scenario = (data as ScenarioSelected).name;
  });
  // Also announced on every prompt; only the state at session start is used.
  pi.events.on(PROJECT_CHANNEL, (data) => {
    project = (data as ProjectAnnounced).project;
  });

  pi.on("session_start", (_event, ctx) => {
    const message = activationMessage(scenario, project);
    // Announcements are per session start: a new/resumed session announces again.
    scenario = undefined;
    project = undefined;
    if (message && ctx.mode === "tui") ctx.ui.notify(message, "info");
  });
}

/** The hint text, or undefined when neither a scenario nor a project is active. */
export function activationMessage(scenario?: string, project?: ProjectAnnounced["project"]): string | undefined {
  const lines: string[] = [];
  if (scenario) lines.push(`Scenario: ${scenario} (its system prompt, tools and skills are active)`);
  if (project) lines.push(`Project: ${project.name} (${project.dir}); /project shows its context`);
  return lines.length ? lines.join("\n") : undefined;
}
