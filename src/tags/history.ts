import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Tag history for `/tags` completion: the tags used in each folder (cwd), shared by every
 * session. An append-only JSONL file in the agent dir; each line is one use,
 * `{ "cwd": "/a/b", "tags": ["bug", "ui"], "at": "2026-11-19T10:00:00.000Z" }`. Appends are
 * small, so parallel sessions do not overwrite each other. Reading folds the lines into the
 * MAX_PER_FOLDER most recently used tags of each folder; a file over COMPACT_BYTES is rewritten
 * with just those (temp file, then rename).
 */

/** Tags kept per folder. */
export const MAX_PER_FOLDER = 10;
/** The file is compacted after an append makes it larger than this. */
export const COMPACT_BYTES = 64 * 1024;

/** The history file in pi's agent dir (`~/.pi/agent` or `PI_CODING_AGENT_DIR`). */
export const historyPath = (agentDir: string) => join(agentDir, "pi-agent", "tag-history.jsonl");

export interface TagUse {
  tag: string;
  /** Time of the last use, ms since the epoch. */
  at: number;
}

/** Folder (cwd) → its tags, most recently used first, at most MAX_PER_FOLDER. */
export type TagHistory = Map<string, TagUse[]>;

/**
 * Folds history lines (oldest first) into each folder's recent tags. In one line, the first
 * tag counts as the most recent. Malformed lines and invalid items are skipped.
 */
export function foldHistory(text: string): TagHistory {
  const out: TagHistory = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: { cwd?: unknown; tags?: unknown; at?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a partly written line
    }
    if (typeof rec?.cwd !== "string" || !Array.isArray(rec.tags)) continue;
    const at = typeof rec.at === "string" ? Date.parse(rec.at) : NaN;
    const time = Number.isFinite(at) ? at : 0;
    let list = out.get(rec.cwd) ?? [];
    for (const tag of [...rec.tags].reverse()) {
      if (typeof tag !== "string" || !tag) continue;
      list = [{ tag, at: time }, ...list.filter((u) => u.tag !== tag)];
    }
    out.set(rec.cwd, list.slice(0, MAX_PER_FOLDER));
  }
  return out;
}

/** The history file folded; an empty history when it is missing or unreadable. */
export async function readHistory(path: string): Promise<TagHistory> {
  return foldHistory(await readFile(path, "utf8").catch(() => ""));
}

/** The folder's tags, most recent first. */
export function folderTags(history: TagHistory, cwd: string): string[] {
  return (history.get(cwd) ?? []).map((u) => u.tag);
}

/** Tags of every other folder, most recent first, each once. */
export function otherTags(history: TagHistory, cwd: string): string[] {
  const uses = [...history].filter(([dir]) => dir !== cwd).flatMap(([, list]) => list);
  uses.sort((a, b) => b.at - a.at);
  return [...new Set(uses.map((u) => u.tag))];
}

/** One history line for a use of `tags` in `cwd`. */
export const historyLine = (cwd: string, tags: string[], at: Date) => JSON.stringify({ cwd, tags, at: at.toISOString() }) + "\n";

/**
 * Records a use of `tags` in `cwd` (nothing for an empty list) and compacts the file when it
 * grew over COMPACT_BYTES.
 */
export async function recordTags(path: string, cwd: string, tags: string[], now = new Date()): Promise<void> {
  if (!tags.length) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, historyLine(cwd, tags, now));
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > COMPACT_BYTES) await compact(path, text);
}

/** Rewrites the file with each folder's recent tags only: one line per tag, oldest first. */
async function compact(path: string, text: string): Promise<void> {
  const lines: string[] = [];
  for (const [cwd, list] of foldHistory(text)) {
    for (const u of [...list].reverse()) lines.push(historyLine(cwd, [u.tag], new Date(u.at)));
  }
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, lines.join(""));
  await rename(tmp, path);
}
