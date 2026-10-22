/**
 * Tool-call handles (`[tool-ref #12]` trailers), shared by the tool-ref extension
 * (src/tool-ref/) and the wrapper's tool log. See docs/tool-ref-design.md.
 */

/** A text block that is exactly a trailer. */
const TRAILER = /^\[tool-ref #(\d+)\]$/;

/** The trailer text for handle `n`, added as its own text block at the end of a tool result. */
export function trailerText(n: number): string {
  return `[tool-ref #${n}]`;
}

interface Block {
  type?: string;
  text?: unknown;
}

/**
 * Index of the trailer block: the last content block, searched from the end, that is a text
 * block exactly matching the trailer. -1 if there is none. Text that only ends with a trailer
 * line does not count.
 */
export function trailerIndex(content: unknown): number {
  if (!Array.isArray(content)) return -1;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as Block | undefined;
    if (block?.type === "text" && typeof block.text === "string" && TRAILER.test(block.text)) return i;
  }
  return -1;
}

/** Handle of a tool result's content, or undefined if it has no trailer. */
export function parseHandle(content: unknown): number | undefined {
  const i = trailerIndex(content);
  if (i < 0) return undefined;
  const n = Number(TRAILER.exec((content as Block[])[i].text as string)![1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Content without its trailer block (the same array if there is none). */
export function withoutTrailer<T>(content: T[]): T[] {
  const i = trailerIndex(content);
  return i < 0 ? content : [...content.slice(0, i), ...content.slice(i + 1)];
}
