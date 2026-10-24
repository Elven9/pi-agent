import { Type } from "typebox";
import systemPrompt from "./prompts/demo.md";
import { defineScenario } from "./types.ts";

/** Minimal scenario for smoke tests: look around with bash, read some files, describe the project. */
export const demo = defineScenario({
  name: "demo",
  detailKind: "demo/v1",
  systemPrompt,
  tools: ["codemode", "read", "bash"],
  detailSchema: Type.Object({
    projectName: Type.String({ description: "Name of the project" }),
    filesRead: Type.Array(Type.String(), { description: "Paths of the files you read" }),
  }),
});
