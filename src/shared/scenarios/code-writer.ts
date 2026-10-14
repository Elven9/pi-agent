import { Type } from "typebox";
import systemPrompt from "./prompts/code-writer.md";
import { defineScenario } from "./types.ts";

/** Implements a requested code change in the workdir. */
export const codeWriter = defineScenario({
  name: "code-writer",
  detailKind: "code-writer/v1",
  systemPrompt,
  tools: ["read", "bash", "edit", "write"],
  detailSchema: Type.Object(
    {
      filesChanged: Type.Array(Type.String({ minLength: 1 }), { description: "Paths of the files you created or changed" }),
    },
    { additionalProperties: false },
  ),
});
