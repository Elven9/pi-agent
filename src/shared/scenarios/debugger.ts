import { Type } from "typebox";
import systemPrompt from "./prompts/debugger.md";
import { defineScenario } from "./types.ts";

/**
 * Investigates bugs: gathers facts and, when asked why something goes wrong, proposes the potential
 * root cause. Reads the code, never changes it.
 */
export const debuggerScenario = defineScenario({
  name: "debugger",
  detailKind: "debugger/v2",
  systemPrompt,
  // No edit or write: the scenario does not change code. bash is for inspecting (logs, tests, git).
  tools: ["codemode", "read", "bash"],
  detailSchema: Type.Object(
    {
      findings: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Facts you gathered, each with its source: code locations, logs, command output",
      }),
      rootCause: Type.Optional(
        Type.String({ minLength: 1, description: "The potential root cause, only when the user asked for one" }),
      ),
    },
    { additionalProperties: false },
  ),
});
