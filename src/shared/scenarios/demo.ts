import { Type } from "typebox";
import { defineScenario } from "./types.ts";

/** Minimal scenario for smoke tests: look around with bash, read some files, describe the project. */
export const demo = defineScenario({
  name: "demo",
  detailKind: "demo/v1",
  systemPrompt: [
    "You are a test agent working in the current directory.",
    "When you are done, call the submit_result tool exactly once with your final result.",
  ].join("\n"),
  tools: ["read", "bash"],
  detailSchema: Type.Object({
    projectName: Type.String({ description: "Name of the project" }),
    filesRead: Type.Array(Type.String(), { description: "Paths of the files you read" }),
  }),
});
