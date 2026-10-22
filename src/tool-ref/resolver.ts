import { parseHandle, TOOL_REF_GET, TOOL_REF_GREP, trailerIndex } from "../shared/tool-ref.ts";

/**
 * Resolver: turns tool-ref handles into tool calls, from raw session entries. No pi state of its
 * own, so the extension, other extensions (report system) and tests use it the same way, live
 * (`ctx.sessionManager`) or offline (a session JSONL file). See docs/tool-ref-design.md.
 */

export { TOOL_REF_GET, TOOL_REF_GREP };

/** tool-ref's own tools; always excluded from `get` and `grep`. */
const OWN_TOOLS: ReadonlySet<string> = new Set([TOOL_REF_GET, TOOL_REF_GREP]);

export const DEFAULT_EXCLUDE: readonly string[] = ["submit_result"];

export interface ToolRefSettings {
  /** Tools whose results `get` and `grep` refuse to show (tool-ref's own tools come on top). */
  exclude: string[];
}

/** `toolRef` from pi's merged settings (`pi.getSettings()`), with defaults applied. */
export function loadSettings(settings: unknown): ToolRefSettings {
  const exclude = (settings as { toolRef?: { exclude?: unknown } } | undefined)?.toolRef?.exclude;
  if (Array.isArray(exclude) && exclude.every((t) => typeof t === "string")) return { exclude: [...exclude] };
  return { exclude: [...DEFAULT_EXCLUDE] };
}

/** The parts of a session entry the resolver reads (pi's `SessionEntry` fits). */
export interface EntryLike {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: unknown;
}

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface ToolRef {
  /** Parsed from the trailer; undefined without one. Ambiguous handles keep their number here. */
  handle: number | undefined;
  /** Another result in the file claims the same handle: not reachable by handle. */
  ambiguous: boolean;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  /** The tool is excluded (settings or a tool-ref tool): `get` and `grep` don't show it. */
  excluded: boolean;
  /** Arguments of the matching tool call; undefined if no call with this id is on the branch. */
  input: Record<string, unknown> | undefined;
  /** Result content without the trailer. */
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  /** Text output: text blocks joined by newlines, images as `[image]`. */
  output: string;
  /** Timestamp of the assistant message with the call (approximate start). */
  startedAt: string | undefined;
  /** Timestamp of the result (approximate end). */
  endedAt: string | undefined;
  durationMs: number | undefined;
  /** Session entry id of the tool result. */
  entryId: string;
}

export interface ToolRefIndex {
  /** Results on the active branch, in branch order. */
  refs: ToolRef[];
  /** Unambiguous handles on the active branch. */
  byHandle: Map<number, ToolRef>;
  /** Every result on the active branch, with or without a handle. */
  byToolCallId: Map<string, ToolRef>;
  /** Handles claimed by more than one result in the file (any branch), with the count. */
  ambiguous: Map<number, number>;
  /** Every handle in the file (any branch). */
  fileHandles: Set<number>;
}

const isToolResult = (e: EntryLike) => e.type === "message" && (e.message as MessageLike | undefined)?.role === "toolResult";

/** Handle → number of results claiming it, over all entries (all branches). */
export function countHandles(entries: readonly EntryLike[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const e of entries) {
    if (!isToolResult(e)) continue;
    const n = parseHandle((e.message as MessageLike).content);
    if (n !== undefined) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}

/** Highest handle in the entries (all branches), 0 if none. */
export function maxHandle(entries: readonly EntryLike[]): number {
  let max = 0;
  for (const n of countHandles(entries).keys()) if (n > max) max = n;
  return max;
}

/** Entries from the root to `leafId`, following `parentId`. */
export function branchOf(entries: readonly EntryLike[], leafId: string | null): EntryLike[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const branch: EntryLike[] = [];
  const seen = new Set<string>();
  for (let e = leafId ? byId.get(leafId) : undefined; e && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : undefined) {
    seen.add(e.id);
    branch.push(e);
  }
  return branch.reverse();
}

export function isExcluded(toolName: string, exclude: readonly string[]): boolean {
  return OWN_TOOLS.has(toolName) || exclude.includes(toolName);
}

const iso = (ms: number | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

/** Text output of result content: text blocks joined by newlines, images as `[image]`. */
export function outputText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
}

/**
 * Index of the active branch. `entries` are all entries of the file (for duplicate
 * detection); the branch is walked from `leafId`. Reads raw entries only, so compaction and
 * context edits hide nothing.
 */
export function indexBranch(entries: readonly EntryLike[], leafId: string | null, exclude: readonly string[]): ToolRefIndex {
  const counts = countHandles(entries);
  const ambiguous = new Map([...counts].filter(([, c]) => c > 1));
  const index: ToolRefIndex = {
    refs: [],
    byHandle: new Map(),
    byToolCallId: new Map(),
    ambiguous,
    fileHandles: new Set(counts.keys()),
  };
  const calls = new Map<string, { input: Record<string, unknown>; startedAt: string | undefined }>();
  for (const entry of branchOf(entries, leafId)) {
    if (entry.type !== "message") continue;
    const m = entry.message as MessageLike | undefined;
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content as Block[]) {
        if (block?.type === "toolCall" && typeof block.id === "string") {
          calls.set(block.id, { input: block.arguments ?? {}, startedAt: iso(m.timestamp) });
        }
      }
      continue;
    }
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
    const raw = (Array.isArray(m.content) ? m.content : []) as ToolRef["content"];
    const handle = parseHandle(raw);
    const t = trailerIndex(raw);
    const content = t < 0 ? raw : raw.filter((_, i) => i !== t);
    const toolName = m.toolName ?? "";
    const call = calls.get(m.toolCallId);
    const ref: ToolRef = {
      handle,
      ambiguous: handle !== undefined && ambiguous.has(handle),
      toolCallId: m.toolCallId,
      toolName,
      isError: m.isError === true,
      excluded: isExcluded(toolName, exclude),
      input: call?.input,
      content,
      output: outputText(content),
      startedAt: call?.startedAt,
      endedAt: iso(m.timestamp),
      durationMs: typeof m.durationMs === "number" ? m.durationMs : undefined,
      entryId: entry.id,
    };
    index.refs.push(ref);
    index.byToolCallId.set(ref.toolCallId, ref);
    if (handle !== undefined && !ref.ambiguous) index.byHandle.set(handle, ref);
  }
  return index;
}

/** Parses a session JSONL file into entries (header and unparsable lines skipped). */
export function parseSessionFile(text: string): EntryLike[] {
  const entries: EntryLike[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: EntryLike;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e && typeof e === "object" && typeof e.id === "string" && e.type !== "session") entries.push(e);
  }
  return entries;
}

/**
 * Offline index of a session file: the active branch ends at the last entry, as when pi loads
 * the file (`--resume` continues there).
 */
export function indexSessionFile(text: string, exclude: readonly string[]): ToolRefIndex {
  const entries = parseSessionFile(text);
  return indexBranch(entries, entries.at(-1)?.id ?? null, exclude);
}

export type Resolved = { ref: ToolRef; error?: undefined } | { ref?: undefined; error: string };

/** A handle the model asked for: the call, or why it can't be shown. */
export function resolveHandle(index: ToolRefIndex, n: number): Resolved {
  const claims = index.ambiguous.get(n);
  if (claims) return { error: `#${n} is ambiguous (${claims} results claim it)` };
  const ref = index.byHandle.get(n);
  if (ref) {
    if (!ref.excluded) return { ref };
    const why = OWN_TOOLS.has(ref.toolName) ? "lookups are not evidence" : "toolRef.exclude";
    return { error: `#${n} is a ${ref.toolName} call, which tool-ref does not show (${why})` };
  }
  if (index.fileHandles.has(n)) return { error: `#${n} is not on the active branch` };
  return { error: `#${n} is unknown (no tool result has this number)` };
}
