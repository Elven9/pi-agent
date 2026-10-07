/**
 * Splits the system prompt of an Anthropic Messages request into two cached blocks:
 *
 *   A = everything before block B (preamble, append prompt, skills, cwd): shared by every
 *       project of a scenario
 *   B = the project sections: shared by every run of one project
 *
 * pi sends the whole system prompt as one text block with one cache marker, so without the
 * split the cache can only be reused when the project is the same too. pi's markers after the
 * tools and on the OAuth identity block are removed so the request keeps at most 4: A, B, the
 * last message (and one spare). Marker A still caches the tools, which come before it.
 *
 * Returns the new payload, or undefined to leave it unchanged: another API's payload, block B
 * not found (e.g. a compaction summary request), or caching off (no marker on the prompt).
 */

/** Separator pi puts between system prompt sections. */
const SEPARATOR = "\n\n";

type Block = { type?: unknown; text?: unknown; cache_control?: unknown; [key: string]: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function withoutMarker<T>(block: T): T {
  if (!isObject(block) || !("cache_control" in block)) return block;
  const { cache_control: _, ...rest } = block;
  return rest as T;
}

export function splitSystemPrompt(payload: unknown, blockB: string): unknown {
  if (!blockB || !isObject(payload) || !Array.isArray(payload.system)) return undefined;
  const system = payload.system as Block[];
  const needle = SEPARATOR + blockB;
  const index = system.findIndex((b) => b?.type === "text" && typeof b.text === "string" && b.text.includes(needle));
  if (index < 0) return undefined;
  const block = system[index];
  if (!block.cache_control) return undefined;

  const text = block.text as string;
  const at = text.indexOf(needle);
  return {
    ...payload,
    system: [
      ...system.slice(0, index).map(withoutMarker),
      { ...block, text: text.slice(0, at) },
      // B runs to the end: sections other extensions add after it stay with it.
      { ...block, text: text.slice(at + SEPARATOR.length) },
      ...system.slice(index + 1),
    ],
    ...(Array.isArray(payload.tools) && { tools: payload.tools.map(withoutMarker) }),
  };
}
