import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY, SCENARIO_CHANNEL, SCENARIO_FLAG, type ScenarioSelected } from "../shared/protocol.ts";
import { getScenario, scenarioNames, type Scenario } from "../shared/scenarios/index.ts";
import { keepSkill, scenarioActiveTools } from "./profile.ts";

/**
 * This package's skills folder. Bundled: dist/scenario-profile.js -> ../skills. From source
 * (tests): src/scenario-profile/index.ts -> ../../skills.
 */
function defaultSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === "dist" ? join(here, "..", "skills") : join(here, "..", "..", "skills");
}

/** Real path, so symlinked package or skill folders still compare equal. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Scenario profile extension, loaded by both the runner (`-e dist/scenario-profile.js`) and
 * personal pi (package manifest). Inert unless pi is started with `--scenario <name>`; then
 * the session gets that scenario's profile:
 *
 * - system prompt: the scenario's prompt replaces pi's default preamble (`customPrompt`, as
 *   `--system-prompt` would); appended prompts, context files, skills, cwd and extension
 *   sections (project context) still follow it,
 * - tools: built-in tools are exactly the scenario's; tools from extensions stay,
 * - skills: other scenarios' skills (`skills/<other scenario>/`) are left out of the prompt.
 *
 * `submit_result` and the result format stay with the runner extension (src/extension/). This
 * extension owns the `--scenario` flag and tells the runner on SCENARIO_CHANNEL.
 */
export default function scenarioProfile(pi: ExtensionAPI, skillsDir: string = defaultSkillsDir()) {
  pi.registerFlag(SCENARIO_FLAG, {
    type: "string",
    description: "pi-agent scenario: use its system prompt, tools and skills",
  });

  let scenario: Scenario | undefined;
  const root = real(skillsDir);
  /** Skill folder -> kept; skills don't move within a session. */
  const kept = new Map<string, boolean>();

  // Flags are only parsed after extensions load, so everything happens from session_start on.
  pi.on("session_start", (_event, ctx) => {
    const name = pi.getFlag(SCENARIO_FLAG);
    if (typeof name !== "string" || name === "") return;
    try {
      scenario = getScenario(name);
    } catch (err) {
      // Startup entries are not streamed in --mode json, so also tell stderr.
      const message = (err as Error).message;
      console.error(`[pi-agent] ${message}`);
      pi.appendEntry(ENTRY.error, { message });
      ctx.shutdown();
      return;
    }
    // Synchronous: the runner registers submit_result before the tools are set below.
    pi.events.emit(SCENARIO_CHANNEL, { name } satisfies ScenarioSelected);
    pi.setActiveTools(scenarioActiveTools(scenario.tools, pi.getActiveTools(), pi.getAllTools()));
  });

  // pi rebuilds the options from its base for every prompt, so set them every time; they
  // never change within a session, so pi sees no delta.
  pi.on("before_agent_start", (event) => {
    if (!scenario) return;
    const options = event.systemPromptOptions;
    options.customPrompt = scenario.systemPrompt;
    const known = scenarioNames();
    const name = scenario.name;
    options.skills = options.skills.filter((s) => {
      let keep = kept.get(s.baseDir);
      if (keep === undefined) kept.set(s.baseDir, (keep = keepSkill(real(s.baseDir), root, name, known)));
      return keep;
    });
  });
}
