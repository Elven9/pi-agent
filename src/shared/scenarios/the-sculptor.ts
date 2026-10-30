import { Type } from "typebox";
import systemPrompt from "./prompts/the-sculptor.md";
import { defineScenario } from "./types.ts";

const Solution = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120, description: "Short name of the solution" }),
    summary: Type.String({ minLength: 1, description: "How it works, self-contained" }),
    pros: Type.Array(Type.String({ minLength: 1 })),
    cons: Type.Array(Type.String({ minLength: 1 })),
    risks: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** Discusses, designs and refines solutions with the user; reads and inspects, never writes code. */
export const theSculptor = defineScenario({
  name: "the-sculptor",
  detailKind: "the-sculptor/v1",
  systemPrompt,
  // write is for design documents only; no edit, the scenario does not change code.
  tools: ["codemode", "read", "bash", "write"],
  rules: [
    "Never write, edit or generate source code, tests or config, and never run commands that change the project. Short snippets inside a design are fine to illustrate an interface.",
    "Use the write tool only for design documents (notes, proposals, decision records) the user asks for.",
    "Prefer simple solutions; name the trade-offs instead of hiding them.",
    "Separate facts (what you read or ran) from assumptions and opinions.",
  ],
  detailSchema: Type.Object(
    {
      problem: Type.String({ minLength: 1, description: "The problem as understood, with its constraints" }),
      solutions: Type.Array(Solution, { minItems: 1, description: "Viable solutions" }),
      recommended: Type.Optional(Type.String({ minLength: 1, description: "Title of the recommended solution, if any" })),
      openQuestions: Type.Array(Type.String({ minLength: 1 }), { description: "Questions still to answer" }),
      documentsWritten: Type.Array(Type.String({ minLength: 1 }), { description: "Paths of design documents you wrote" }),
    },
    { additionalProperties: false },
  ),
});
