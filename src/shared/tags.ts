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
  /**
   * What set it: the `--tags` flag (or task.json), the `/tags` command, or `default` (the
   * last segment of the cwd, for a session never tagged).
   */
  source: "flag" | "command" | "default";
}

/**
 * The default tag for a cwd: its last path segment, lowercased, with every run of characters a
 * tag cannot hold turned into `-` (trimmed at the ends), cut to the maximum length. Undefined
 * when nothing usable is left (e.g. `/`).
 */
export function defaultTag(cwd: string): string | undefined {
  const segment = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const tag = segment
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .slice(0, MAX_TAG_LENGTH)
    .replace(/^-+|-+$/g, "");
  return TAG_PATTERN.test(tag) ? tag : undefined;
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

/** A group of preset tags; `name` is undefined for the plain-list form. */
export interface PresetGroup {
  name?: string;
  tags: string[];
}

/**
 * `tags.presets` from pi's merged settings (`pi.getSettings()`): frequently used tags that
 * `/tags` completion always offers. Either a plain list (one unnamed group) or an object of
 * named groups, `{ "work": ["bug", "feature"], "ops": ["deployment"] }`, in the order given;
 * groups are for display only. Tags are normalized; a tag already in an earlier group is left
 * out; invalid items and groups that are not lists are returned in `invalid`. A missing or
 * malformed setting is no presets; empty groups are dropped.
 */
export function presetTags(settings: unknown): { groups: PresetGroup[]; invalid: string[] } {
  const presets = (settings as { tags?: { presets?: unknown } } | undefined)?.tags?.presets;
  const groups: PresetGroup[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  const group = (name: string | undefined, items: unknown[]) => {
    const tags: string[] = [];
    for (const item of items) {
      if (typeof item !== "string") {
        invalid.push(JSON.stringify(item));
        continue;
      }
      try {
        for (const t of normalizeTags([item])) {
          if (!seen.has(t)) tags.push(t);
          seen.add(t);
        }
      } catch {
        invalid.push(JSON.stringify(item.trim()));
      }
    }
    if (tags.length) groups.push(name === undefined ? { tags } : { name, tags });
  };
  if (Array.isArray(presets)) {
    group(undefined, presets);
  } else if (presets !== null && typeof presets === "object") {
    for (const [name, items] of Object.entries(presets)) {
      if (!Array.isArray(items)) invalid.push(`group ${JSON.stringify(name)} (not a list)`);
      else group(name.trim() || undefined, items);
    }
  }
  return { groups, invalid };
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
