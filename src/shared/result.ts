import { Type, type TObject, type TSchema, type TString } from "typebox";
import { Value } from "typebox/value";
import type { Scenario } from "./scenarios/index.ts";

/** Common result envelope; `detail` is scenario-specific and tagged by `detailKind`. */
export interface SubmittedResult {
  summary: string;
  detailKind: string;
  detail: unknown;
}

/**
 * Parameters of the `submit_result` tool, identical for every scenario. Tool definitions are
 * the first part of the cached prompt prefix, so a per-scenario schema here would give every
 * scenario its own cache from byte 0. The scenario's detail format is sent in the conversation
 * instead (`resultFormatMessage`) and checked by the tool (`detailErrors`).
 */
export const SUBMIT_PARAMETERS = Type.Object({
  summary: Type.String({ description: "One or two sentence summary of the outcome" }),
  detail: Type.Object(
    {},
    {
      additionalProperties: true,
      description: "Structured result. Must follow the result format given in the conversation.",
    },
  ),
});

/** Full schema of a scenario's result (`summary` + the scenario's detail), for validation. */
export function resultSchema(scenario: Scenario): TObject<{ summary: TString; detail: TSchema }> {
  return Type.Object({
    summary: SUBMIT_PARAMETERS.properties.summary,
    detail: scenario.detailSchema,
  });
}

/** Error messages for `value` against `schema`; empty when valid. */
export function schemaErrors(schema: TSchema, value: unknown): string[] {
  return Value.Check(schema, value)
    ? []
    : Value.Errors(schema, value).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

/** Errors of `detail` against the scenario's detail schema, with paths under `/detail`. */
export function detailErrors(scenario: Scenario, detail: unknown): string[] {
  return schemaErrors(scenario.detailSchema, detail).map((e) => `/detail${e.startsWith("/ ") ? e.slice(1) : e}`);
}

/**
 * Model-facing description of the scenario's `detail` format, sent once as a message after the
 * task prompt. The JSON Schema is the same one the tool validates against.
 */
export function resultFormatMessage(scenario: Scenario): string {
  return [
    `Result format (${scenario.detailKind}): when you are done, call submit_result with a short \`summary\``,
    "and a `detail` object that matches this JSON Schema:",
    "",
    "```json",
    JSON.stringify(scenario.detailSchema, null, 2),
    "```",
  ].join("\n");
}

/**
 * Checks a result taken from the session (the `details` of a `submit_result` call) against the
 * scenario. Returns error messages; empty when valid.
 */
export function validateResult(scenario: Scenario, result: unknown): string[] {
  const r = result as Partial<SubmittedResult> | null;
  if (r === null || typeof r !== "object") return ["result is not an object"];
  const errors = schemaErrors(resultSchema(scenario), { summary: r.summary, detail: r.detail });
  if (r.detailKind !== scenario.detailKind) {
    errors.push(`detailKind is ${JSON.stringify(r.detailKind)}, expected ${JSON.stringify(scenario.detailKind)}`);
  }
  return errors;
}
