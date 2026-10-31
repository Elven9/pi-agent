import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { normalizeTags } from "./tags.ts";

export const TaskSchema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  scenario: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  /** Model override as "provider/modelId". Default: pi settings. */
  model: Type.Optional(Type.String({ pattern: "^[^/]+/.+$" })),
  thinkingLevel: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ]),
  ),
  /** Session tags (see src/shared/tags.ts), recorded in the session file; normalized on load. */
  tags: Type.Optional(Type.Array(Type.String())),
});
export type Task = Static<typeof TaskSchema>;

export async function loadTask(path: string): Promise<Task> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read task file ${path}: ${(err as Error).message}`);
  }
  if (!Value.Check(TaskSchema, raw)) {
    const errors = Value.Errors(TaskSchema, raw).map((e) => `${e.instancePath} ${e.message}`);
    throw new Error(`Invalid task file:\n${errors.join("\n")}`);
  }
  if (raw.tags) {
    try {
      raw.tags = normalizeTags(raw.tags);
    } catch (err) {
      throw new Error(`Invalid task file:\n/tags ${(err as Error).message}`);
    }
  }
  return raw;
}
