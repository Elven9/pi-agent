import { demo } from "./demo.ts";
import type { Scenario } from "./types.ts";

export type { Scenario } from "./types.ts";
export { defineScenario } from "./types.ts";

const registry = new Map<string, Scenario>([demo].map((s) => [s.name, s]));

export function getScenario(name: string): Scenario {
  const scenario = registry.get(name);
  if (!scenario) {
    throw new Error(`Unknown scenario "${name}" (known: ${[...registry.keys()].join(", ")})`);
  }
  return scenario;
}
