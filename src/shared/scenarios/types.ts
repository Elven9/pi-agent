import type { TObject } from "typebox";
import { validateExternalSkills, type ExternalSkillsConfig } from "../external-skills.ts";

/**
 * Scenario = profile (prompt + tools) + detail schema. Its skills come from the folder layout:
 * shared `skills/<skill>/` (and grouped `skills/<group>/<skill>/`) plus `skills/<scenario name>/<skill>/` (see src/wrapper/skills.ts),
 * plus the external skills it includes (`externalSkills`, see src/shared/external-skills.ts).
 *
 * The wrapper turns the profile into pi CLI flags. `submit_result` has the same parameters in
 * every scenario (keeps the cached prompt prefix shared); the extension sends `detailSchema` to
 * the model as a message and validates `detail` against it in the tool.
 */
export interface Scenario<TDetail extends TObject = TObject> {
  /** Name referenced by `task.scenario`. */
  name: string;
  /** Versioned format tag copied into `report.result.detailKind`, e.g. "code-review/v1". */
  detailKind: string;
  /**
   * System prompt for the agent (replaces pi's default prompt). Usually imported from
   * `prompts/<name>.md` in this folder; leading/trailing whitespace is trimmed.
   */
  systemPrompt: string;
  /** Built-in pi tool names to enable. `submit_result` is always added. */
  tools: string[];
  /** TypeBox schema for `result.detail` (an object). Its JSON Schema is shown to the model. */
  detailSchema: TDetail;
  /**
   * External skills (installed on the machine outside this package) to include, by skill name;
   * all others are excluded, and included ones that are not installed are ignored. See
   * ExternalSkillsConfig.
   */
  externalSkills?: ExternalSkillsConfig;
}

/**
 * Keeps the detail schema's type and trims the system prompt (Markdown files end with a newline).
 * Throws on an invalid `externalSkills` (an empty or duplicate name).
 */
export function defineScenario<TDetail extends TObject>(scenario: Scenario<TDetail>): Scenario<TDetail> {
  validateExternalSkills(scenario.name, scenario.externalSkills);
  return { ...scenario, systemPrompt: scenario.systemPrompt.trim() };
}
