import type { TSchema } from "typebox";

/**
 * Scenario = profile (prompt + tools + skills) + detail schema.
 *
 * The wrapper turns the profile into pi CLI flags. The extension builds `submit_result` from
 * the shared envelope (`summary`) plus `detailSchema`, so pi validates the scenario-specific
 * part of the result.
 */
export interface Scenario<TDetail extends TSchema = TSchema> {
  /** Name referenced by `task.scenario`. */
  name: string;
  /** Versioned format tag copied into `report.result.detailKind`, e.g. "code-review/v1". */
  detailKind: string;
  /** System prompt for the agent (replaces pi's default prompt). */
  systemPrompt: string;
  /** Built-in pi tool names to enable. `submit_result` is always added. */
  tools: string[];
  /**
   * Skill files/dirs to load, relative to the repo root (e.g. "skills/foo"). Other skills are
   * never loaded implicitly.
   */
  skillPaths?: string[];
  /** TypeBox schema for `result.detail`. */
  detailSchema: TDetail;
}

/** Identity helper that keeps the detail schema's type. */
export function defineScenario<TDetail extends TSchema>(scenario: Scenario<TDetail>): Scenario<TDetail> {
  return scenario;
}
