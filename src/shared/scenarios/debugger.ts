import { Type } from "typebox";
import systemPrompt from "./prompts/debugger.md";
import { defineScenario } from "./types.ts";

/** Investigates a bug and proposes its potential root cause; reads the code, never changes it. */
export const debuggerScenario = defineScenario({
  name: "debugger",
  detailKind: "debugger/v1",
  systemPrompt,
  // No edit or write: the scenario does not change code. bash is for inspecting (logs, tests, git).
  tools: ["codemode", "read", "bash"],
  detailSchema: Type.Object(
    {
      rootCause: Type.String({ minLength: 1, description: "The potential root cause of the bug" }),
      evidence: Type.Array(Type.String({ minLength: 1 }), { description: "What supports it: code locations, logs, command output" }),
    },
    { additionalProperties: false },
  ),
});
