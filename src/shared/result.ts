import { Type, type TObject, type TSchema, type TString } from "typebox";
import { Value } from "typebox/value";
import type { Scenario } from "./scenarios/index.ts";

/** Common result envelope; `detail` is scenario-specific and tagged by `detailKind`. */
export interface SubmittedResult {
  summary: string;
  detailKind: string;
  detail: unknown;
}

/** Arguments of the `submit_result` tool for a scenario: `summary` + the scenario's detail. */
export function resultSchema(scenario: Scenario): TObject<{ summary: TString; detail: TSchema }> {
  return Type.Object({
    summary: Type.String({ description: "One or two sentence summary of the outcome" }),
    detail: scenario.detailSchema,
  });
}

/** Error messages for `value` against `schema`; empty when valid. */
export function schemaErrors(schema: TSchema, value: unknown): string[] {
  return Value.Check(schema, value)
    ? []
    : Value.Errors(schema, value).map((e) => `${e.instancePath || "/"} ${e.message}`);
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
