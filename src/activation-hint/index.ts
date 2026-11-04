import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROJECT_CHANNEL,
  SCENARIO_CHANNEL,
  SKILLS_CHANNEL,
  type ProjectAnnounced,
  type ScenarioSelected,
  type SkillsAnnounced,
} from "../shared/protocol.ts";

/**
 * Activation hint (personal pi, TUI only). After session start, shows one info notification with
 * the active scenario (`--scenario`), the project (`--project` or settings.json) and the skills
 * the prompts get (after the scenario's and the project's selection, announced by the scenario
 * profile extension). Without a scenario and a project it still lists the skills. pi's built-in
 * header is left as it is.
 *
 * All three are announced from the session_start of the scenario-profile and project
 * extensions, so this extension must load after them: pi runs session_start handlers in load
 * order, each awaited before the next.
 */
export default function activationHint(pi: ExtensionAPI) {
  let scenario: string | undefined;
  let project: ProjectAnnounced["project"];
  let skills: SkillsAnnounced | undefined;

  pi.events.on(SCENARIO_CHANNEL, (data) => {
    scenario = (data as ScenarioSelected).name;
  });
  // Also announced on every prompt; only the state at session start is used.
  pi.events.on(PROJECT_CHANNEL, (data) => {
    project = (data as ProjectAnnounced).project;
  });
  // The last announcement before our session_start is the final list.
  pi.events.on(SKILLS_CHANNEL, (data) => {
    skills = data as SkillsAnnounced;
  });

  pi.on("session_start", (_event, ctx) => {
    const message = activationMessage(scenario, project, skills);
    // Announcements are per session start: a new/resumed session announces again.
    scenario = undefined;
    project = undefined;
    skills = undefined;
    if (message && ctx.mode === "tui") ctx.ui.notify(message, "info");
  });
}

/** The hint text, or undefined when there is nothing to show. */
export function activationMessage(
  scenario?: string,
  project?: ProjectAnnounced["project"],
  skills?: SkillsAnnounced,
): string | undefined {
  const lines: string[] = [];
  if (scenario) lines.push(`Scenario: ${scenario} (its system prompt, tools and skills are active)`);
  if (project) lines.push(`Project: ${project.name} (${project.dir}); /project shows its context`);
  if (skills) {
    lines.push(`Skills: ${skills.skills.length ? skills.skills.join(", ") : "none"}`);
    if (skills.missing.length) lines.push(`Not installed (project.yaml skills, skipped): ${skills.missing.join(", ")}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}
