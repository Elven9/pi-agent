import { ENTRY } from "./protocol.ts";

/**
 * Session tags: a list of simple strings recorded in the session file as `pi-agent.tags` custom
 * entries (not model context). Each entry holds the whole list; the last entry in the file wins,
 * for the whole session (not per branch). Shared by the tags extension, the wrapper and anything
 * that reads session files later.
 */

/** Extension CLI flag: `pi --tags a,b`. pi keeps only the last of a repeated flag, so one comma-separated value. */
export const TAGS_FLAG = "tags";

/** Lowercase letters, digits and `. _ : / -`. */
export const TAG_PATTERN = /^[a-z0-9._:/-]+$/;
export const MAX_TAG_LENGTH = 64;

export const TAGS_ENTRY_VERSION = 1;

export interface TagsEntry {
  version: typeof TAGS_ENTRY_VERSION;
  /** The session's whole tag list, in the order given; may be empty (cleared). */
  tags: string[];
  /** What set it: the `--tags` flag (or task.json) or the `/tags` command. */
  source: "flag" | "command";
}

/**
 * Normalizes tags: trimmed, lowercased, empty items dropped, duplicates removed (first kept).
 * Throws listing every invalid tag.
 */
export function normalizeTags(tags: Iterable<string>): string[] {
  const out: string[] = [];
  const bad: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag === "") continue;
    if (!TAG_PATTERN.test(tag) || tag.length > MAX_TAG_LENGTH) bad.push(JSON.stringify(raw.trim()));
    else if (!out.includes(tag)) out.push(tag);
  }
  if (bad.length) {
    throw new Error(
      `Invalid tag${bad.length > 1 ? "s" : ""} ${bad.join(", ")}: use up to ${MAX_TAG_LENGTH} of a-z 0-9 . _ : / -`,
    );
  }
  return out;
}

/** A comma-separated list (`--tags`, `/tags`), normalized. */
export function parseTags(text: string): string[] {
  return normalizeTags(text.split(","));
}

/** Tags of a valid `pi-agent.tags` entry, else undefined (other entries, malformed data). */
export function entryTags(entry: unknown): string[] | undefined {
  const e = entry as { type?: unknown; customType?: unknown; data?: { tags?: unknown } } | null;
  if (e?.type !== "custom" || e.customType !== ENTRY.tags) return undefined;
  const tags = e.data?.tags;
  return Array.isArray(tags) && tags.every((t) => typeof t === "string") ? tags : undefined;
}

/** The session's tags: those of the last tags entry. Undefined when it has none (never tagged). */
export function currentTags(entries: Iterable<unknown>): string[] | undefined {
  let tags: string[] | undefined;
  for (const entry of entries) tags = entryTags(entry) ?? tags;
  return tags;
}

/** Every tags entry's list, in file order (history of changes). */
export function tagHistory(entries: Iterable<unknown>): string[][] {
  const out: string[][] = [];
  for (const entry of entries) {
    const tags = entryTags(entry);
    if (tags) out.push(tags);
  }
  return out;
}

/** Tags entries of a session file's text (JSONL); lines that are not tags entries are skipped unparsed. */
export function sessionFileTagEntries(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(ENTRY.tags)) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partly written last line.
    }
  }
  return out;
}

/** The tags of a session file's text (JSONL), as `currentTags`. */
export function sessionFileTags(text: string): string[] | undefined {
  return currentTags(sessionFileTagEntries(text));
}
