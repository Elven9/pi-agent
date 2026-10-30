import { codeWriter } from "./code-writer.ts";
import { demo } from "./demo.ts";
import { theSculptor } from "./the-sculptor.ts";
import type { Scenario } from "./types.ts";
import { workRequestTriage } from "./work-request-triage.ts";

export type { Scenario } from "./types.ts";
export { defineScenario } from "./types.ts";

const registry = new Map<string, Scenario>([demo, workRequestTriage, codeWriter, theSculptor].map((s) => [s.name, s]));

/** Registered scenario names (also the names of scenario skill folders, `skills/<scenario>/`). */
export function scenarioNames(): string[] {
  return [...registry.keys()];
}

export function getScenario(name: string): Scenario {
  const scenario = registry.get(name);
  if (!scenario) {
    throw new Error(`Unknown scenario "${name}" (known: ${[...registry.keys()].join(", ")})`);
  }
  return scenario;
}
