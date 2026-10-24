import { Type } from "typebox";
import systemPrompt from "./prompts/work-request-triage.md";
import { defineScenario } from "./types.ts";

/** Task categories. Adding one is backward compatible; renaming or removing one needs a new `detailKind`. */
export const WORK_REQUEST_CATEGORIES = [
  "feature_request",
  "bug_report",
  "spec_review",
  "code_review",
  "question",
  "ops",
  "chore",
  "not_actionable",
  "other",
] as const;

const Category = Type.Union(
  WORK_REQUEST_CATEGORIES.map((c) => Type.Literal(c)),
  { description: "Category of this request (see the system prompt)" },
);

const Field = Type.Object(
  {
    key: Type.String({ minLength: 1, description: "Field name, snake_case; the project workflow's name if it gives one" }),
    value: Type.String({ minLength: 1, description: "Extracted value" }),
    evidence: Type.String({ minLength: 1, description: "Exact quote from the text that supports the value" }),
  },
  { additionalProperties: false },
);

const WorkTask = Type.Object(
  {
    category: Category,
    title: Type.String({ minLength: 1, maxLength: 120, description: "Short imperative title" }),
    description: Type.String({ minLength: 1, description: "Self-contained description of the request" }),
    fields: Type.Array(Field, { description: "Extracted information; only what the text states" }),
    missingInfo: Type.Array(Type.String({ minLength: 1 }), {
      description: "Information needed to act on the request that the text does not give",
    }),
    priority: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("urgent")], {
        description: "Only when the text states urgency or a deadline",
      }),
    ),
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
      description: "Confidence in the category and the extracted fields",
    }),
  },
  { additionalProperties: false },
);

/** Categorizes free-form work request text (messages from coworkers) into tasks with extracted fields. */
export const workRequestTriage = defineScenario({
  name: "work-request-triage",
  detailKind: "work-request-triage/v1",
  systemPrompt,
  // Only to read the project's extraction workflows; no bash, the text is the whole input.
  tools: ["codemode", "read"],
  detailSchema: Type.Object(
    {
      tasks: Type.Array(WorkTask, { minItems: 1, description: "One entry per request in the text" }),
      clarifyingQuestions: Type.Array(Type.String({ minLength: 1 }), {
        description: "Questions to send back to the sender, for the missing information",
      }),
      needsHuman: Type.Boolean({ description: "True if a person should check this triage" }),
    },
    { additionalProperties: false },
  ),
});
