import { resolveHandle, type ToolRef, type ToolRefIndex } from "./resolver.ts";

/**
 * Model-facing text of `tool_ref_get` and `tool_ref_grep`. Pure functions over a resolver
 * index (src/tool-ref/resolver.ts), so other extensions and tests use them directly.
 */

/** At most this many handles per `get` or `grep` call. */
export const MAX_REFS = 10;
export const DEFAULT_MAX_CHARS = 4000;
/** grep caps: matching lines per call, matching lines in total, characters per shown line. */
export const GREP_PER_CALL = 5;
export const GREP_TOTAL = 50;
export const GREP_LINE_CHARS = 200;
const SUMMARY_CHARS = 100;

const PATH_TOOLS = new Set(["read", "edit", "write"]);

/** Cuts to the first line (plus `…` if there were more) and to `max` characters. */
export function oneLine(text: string, max = SUMMARY_CHARS): string {
  const nl = text.indexOf("\n");
  let line = nl < 0 ? text : text.slice(0, nl);
  let cut = nl >= 0;
  if (line.length > max) {
    line = line.slice(0, max);
    cut = true;
  }
  return cut ? `${line}…` : line;
}

/** One-line input summary: `bash` command, `read`/`edit`/`write` path, else compact JSON. */
export function inputSummary(ref: Pick<ToolRef, "toolName" | "input">): string {
  const input = ref.input;
  if (!input) return "(call not found)";
  if (ref.toolName === "bash" && typeof input.command === "string") return oneLine(input.command);
  if (PATH_TOOLS.has(ref.toolName) && typeof input.path === "string") return oneLine(input.path);
  return oneLine(JSON.stringify(input));
}

/**
 * Input as lines (`in:N` in grep): the `bash` command as is, otherwise one `key: value` per
 * argument, strings raw (multi-line strings continue on the next lines), others as JSON.
 */
export function inputLines(ref: Pick<ToolRef, "toolName" | "input">): string[] {
  const input = ref.input;
  if (!input) return [];
  if (ref.toolName === "bash" && typeof input.command === "string" && Object.keys(input).length === 1) {
    return input.command.split("\n");
  }
  return Object.entries(input).flatMap(([key, value]) =>
    `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`.split("\n"),
  );
}

/** Output as lines (`out:N`); `image` marks the `[image]` placeholder lines. */
export function outputLines(ref: Pick<ToolRef, "content">): { lines: string[]; image: boolean[] } {
  const lines: string[] = [];
  const image: boolean[] = [];
  for (const block of ref.content) {
    if (block.type === "text") {
      for (const line of (block.text ?? "").split("\n")) {
        lines.push(line);
        image.push(false);
      }
    } else {
      lines.push(`[${block.type}]`);
      image.push(true);
    }
  }
  // A result with only an empty text block (or nothing) has no output lines.
  if (lines.length === 1 && lines[0] === "") return { lines: [], image: [] };
  return { lines, image };
}

const status = (ref: ToolRef) => (ref.isError ? "ERR" : "ok");
const handleText = (ref: ToolRef) => (ref.handle !== undefined && !ref.ambiguous ? `#${ref.handle}` : "#?");

export type Part = "output" | "input" | "both";

export interface GetOptions {
  part?: Part;
  /** 1-based inclusive output line range; negative numbers count from the end (-1: last line). */
  lines?: [number, number];
  /** Characters of input and output shown for this ref. */
  maxChars?: number;
}

export interface GetShown {
  handle: number;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  entryId: string;
  /** Output lines shown (1-based, inclusive) and the total; absent if no output was shown. */
  output?: { from: number; to: number; total: number };
  /** Input or output was cut by `maxChars`. */
  cut: boolean;
}

function cutChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max))}… [${text.length - Math.max(0, max)} more chars]`;
}

/** Text for one ref of `tool_ref_get`. */
export function formatGet(ref: ToolRef & { handle: number }, options: GetOptions = {}): { text: string; shown: GetShown } {
  const part = options.part ?? "output";
  let budget = options.maxChars ?? DEFAULT_MAX_CHARS;
  const shown: GetShown = {
    handle: ref.handle,
    toolCallId: ref.toolCallId,
    toolName: ref.toolName,
    isError: ref.isError,
    entryId: ref.entryId,
    cut: false,
  };
  const out: string[] = [];
  if (part === "output") out.push(`#${ref.handle} ${ref.toolName} ${status(ref)} · input: ${inputSummary(ref)}`);
  else {
    out.push(`#${ref.handle} ${ref.toolName} ${status(ref)}`);
    const input = ref.input ? inputLines(ref).join("\n") : "(call not found)";
    const text = cutChars(input, budget);
    shown.cut ||= text !== input;
    budget -= text.length;
    out.push("input:", text);
  }
  if (part === "input") return { text: out.join("\n"), shown };

  const { lines } = outputLines(ref);
  const total = lines.length;
  if (total === 0) {
    out.push("output: (none)");
    return { text: out.join("\n"), shown };
  }
  const at = (n: number) => (n < 0 ? total + 1 + n : n);
  let from = 1;
  let to = total;
  if (options.lines) {
    from = Math.max(1, at(options.lines[0]));
    to = Math.min(total, at(options.lines[1]));
    if (from > to) {
      out.push(`output: lines ${options.lines[0]}..${options.lines[1]} are outside 1-${total}`);
      return { text: out.join("\n"), shown };
    }
  }
  // Fill the budget from the start of the range, or from its end for a tail request.
  const tail = (options.lines?.[0] ?? 1) < 0;
  const width = String(to).length;
  const render = (n: number) => `${String(n).padStart(width)}  ${lines[n - 1]}`;
  const picked: string[] = [];
  let first = from;
  let last = to;
  let used = 0;
  const range = tail ? Array.from({ length: to - from + 1 }, (_, i) => to - i) : Array.from({ length: to - from + 1 }, (_, i) => from + i);
  for (const n of range) {
    let line = render(n);
    if (used + line.length + 1 > budget) {
      if (picked.length > 0) {
        if (tail) first = n + 1;
        else last = n - 1;
        break;
      }
      line = cutChars(line, budget);
      shown.cut = true;
    }
    picked.push(line);
    used += line.length + 1;
  }
  if (tail) picked.reverse();
  const partial = first !== 1 || last !== total;
  out.push(partial ? `output lines ${first}-${last} of ${total}:` : `output (${total} line${total === 1 ? "" : "s"}):`, ...picked);
  if (first !== from || last !== to) {
    shown.cut = true;
    const rest: [number, number] = tail ? [from, first - 1] : [last + 1, to];
    out.push(`… lines ${rest[0]}-${rest[1]} not shown (maxChars ${options.maxChars ?? DEFAULT_MAX_CHARS}); request lines [${rest[0]}, ${rest[1]}] or raise maxChars`);
  }
  shown.output = { from: first, to: last, total };
  return { text: out.join("\n"), shown };
}

/** `tool_ref_get` over several handles: per-ref errors inline, the other refs still shown. */
export function formatGetMany(index: ToolRefIndex, refs: number[], options: GetOptions = {}): { text: string; results: Array<GetShown | { handle: number; error: string }> } {
  if (refs.length === 0) throw new Error("Give at least one handle in refs.");
  if (refs.length > MAX_REFS) throw new Error(`At most ${MAX_REFS} refs per call (got ${refs.length}); split the call.`);
  const texts: string[] = [];
  const results: Array<GetShown | { handle: number; error: string }> = [];
  for (const n of new Set(refs)) {
    const r = resolveHandle(index, n);
    if (r.error !== undefined) {
      texts.push(r.error);
      results.push({ handle: n, error: r.error });
      continue;
    }
    const { text, shown } = formatGet(r.ref as ToolRef & { handle: number }, options);
    texts.push(text);
    results.push(shown);
  }
  return { text: texts.join("\n\n"), results };
}

/**
 * Parses `/ref` arguments: handles, with or without `#`, separated by spaces or commas.
 * Throws with a usage message on anything else.
 */
export function parseRefArgs(args: string): number[] {
  const words = args.split(/[\s,]+/).filter(Boolean);
  const refs = words.map((w) => (/^#?\d+$/.test(w) ? Number(w.replace("#", "")) : NaN));
  if (words.length === 0 || refs.some((n) => !Number.isSafeInteger(n) || n < 1)) {
    throw new Error("Usage: /ref <N> [N ...], e.g. /ref 12 or /ref #12 #14");
  }
  if (refs.length > MAX_REFS) throw new Error(`At most ${MAX_REFS} refs at a time (got ${refs.length}).`);
  return refs;
}

/**
 * Text of the `/ref` command (for the user, not the model): per handle the call's details, its
 * whole input and its whole output (no character cap), without the trailer. Excluded calls are
 * shown too, marked; other problems (unknown, other branch, ambiguous) inline as in `get`.
 */
export function formatRefView(index: ToolRefIndex, refs: number[]): string {
  const texts: string[] = [];
  for (const n of new Set(refs)) {
    const r = resolveHandle(index, n, { allowExcluded: true });
    if (r.error !== undefined) {
      texts.push(r.error);
      continue;
    }
    const ref = r.ref as ToolRef & { handle: number };
    const facts = [
      `call ${ref.toolCallId}`,
      ref.startedAt && `started ${ref.startedAt}`,
      ref.durationMs !== undefined && `${ref.durationMs} ms`,
      `entry ${ref.entryId}`,
      ref.excluded && "excluded from tool_ref_get/grep",
    ].filter(Boolean);
    // Input and output separately, each without formatGet's header line; a blank line between parts.
    const part = (p: Part) => formatGet(ref, { part: p, maxChars: Number.POSITIVE_INFINITY }).text.split("\n").slice(1);
    const header = `#${ref.handle} ${ref.toolName} ${status(ref)}`;
    texts.push([`──── ${header} ────`, facts.join(" · "), "", ...part("input"), "", ...part("output")].join("\n"));
  }
  return texts.join("\n\n");
}

export type Where = "in" | "out";

export interface GrepOptions {
  pattern: string;
  in?: "input" | "output" | "both";
  refs?: number[];
  tool?: string | string[];
  errors?: boolean;
  context?: number;
}

export interface GrepCall {
  ref: ToolRef;
  /** Matching lines, input first, 1-based. */
  matches: Array<{ where: Where; line: number }>;
}

export interface GrepResult {
  regex: RegExp;
  /** Calls with at least one match, newest first. */
  calls: GrepCall[];
  /** Per-ref problems for handles given in `refs` (excluded, unknown, …). */
  notes: string[];
}

/**
 * Smart case like `rg`: case-insensitive unless the pattern has an uppercase letter outside
 * escapes (`\S`, `\W`, `\p{Lu}` don't count). Throws on an invalid pattern, naming it.
 */
export function compilePattern(pattern: string): RegExp {
  const literal = pattern.replace(/\\[pPk]\{[^}]*\}|\\./g, "");
  try {
    return new RegExp(pattern, /[A-Z]/.test(literal) ? "" : "i");
  } catch (err) {
    throw new Error(`Invalid pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`);
  }
}

/** Finds calls on the active branch whose input or output lines match. Excluded calls are skipped silently. */
export function grepRefs(index: ToolRefIndex, options: GrepOptions): GrepResult {
  const regex = compilePattern(options.pattern);
  const where = options.in ?? "both";
  const tools = options.tool === undefined ? undefined : new Set([options.tool].flat());
  const notes: string[] = [];
  let candidates: ToolRef[];
  if (options.refs) {
    if (options.refs.length > MAX_REFS) throw new Error(`At most ${MAX_REFS} refs per call (got ${options.refs.length}); split the call.`);
    candidates = [];
    for (const n of new Set(options.refs)) {
      const r = resolveHandle(index, n);
      if (r.error !== undefined) notes.push(r.error);
      else candidates.push(r.ref);
    }
    // Newest first, like a search over everything.
    candidates.sort((a, b) => index.refs.indexOf(b) - index.refs.indexOf(a));
  } else {
    candidates = index.refs.filter((r) => !r.excluded).reverse();
  }
  const calls: GrepCall[] = [];
  for (const ref of candidates) {
    if (tools && !tools.has(ref.toolName)) continue;
    if (options.errors !== undefined && ref.isError !== options.errors) continue;
    const matches: GrepCall["matches"] = [];
    if (where !== "output") {
      inputLines(ref).forEach((line, i) => regex.test(line) && matches.push({ where: "in", line: i + 1 }));
    }
    if (where !== "input") {
      const { lines, image } = outputLines(ref);
      lines.forEach((line, i) => !image[i] && regex.test(line) && matches.push({ where: "out", line: i + 1 }));
    }
    if (matches.length > 0) calls.push({ ref, matches });
  }
  return { regex, calls, notes };
}

export interface GrepFormatOptions {
  context?: number;
  perCall?: number;
  total?: number;
  lineChars?: number;
}

/** A long line cut to a window around the match. */
function window(line: string, regex: RegExp, max: number): string {
  if (line.length <= max) return line;
  const at = Math.max(0, regex.exec(line)?.index ?? 0);
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), line.length - max));
  return `${start > 0 ? "…" : ""}${line.slice(start, start + max)}${start + max < line.length ? "…" : ""}`;
}

/** Text of `tool_ref_grep`: matches grouped by call with `in:N` / `out:N` line numbers, capped. */
export function formatGrep(result: GrepResult, options: GrepFormatOptions = {}): {
  text: string;
  shown: Array<{ handle: number | undefined; toolCallId: string; toolName: string; matches: GrepCall["matches"] }>;
  omitted: { matches: number; calls: number };
} {
  const context = Math.max(0, options.context ?? 0);
  const perCall = options.perCall ?? GREP_PER_CALL;
  const total = options.total ?? GREP_TOTAL;
  const lineChars = options.lineChars ?? GREP_LINE_CHARS;
  const out: string[] = [...result.notes];
  const shown: ReturnType<typeof formatGrep>["shown"] = [];
  const omitted = { matches: 0, calls: 0 };
  let left = total;
  const handleWidth = Math.max(0, ...result.calls.map((c) => handleText(c.ref).length));
  for (const call of result.calls) {
    const take = Math.min(perCall, left, call.matches.length);
    if (take < call.matches.length) {
      omitted.matches += call.matches.length - take;
      omitted.calls++;
    }
    if (take === 0) continue;
    left -= take;
    const { ref } = call;
    const matches = call.matches.slice(0, take);
    shown.push({ handle: ref.ambiguous ? undefined : ref.handle, toolCallId: ref.toolCallId, toolName: ref.toolName, matches });
    out.push(`${handleText(ref).padEnd(handleWidth)} ${ref.toolName} ${status(ref).padEnd(3)}  ${inputSummary(ref)}`);
    const sources: Record<Where, string[]> = { in: inputLines(ref), out: outputLines(ref).lines };
    // Lines to show per source: matches plus context, in order.
    const rows: Array<{ where: Where; line: number; match: boolean }> = [];
    for (const where of ["in", "out"] as const) {
      const hits = new Set(matches.filter((m) => m.where === where).map((m) => m.line));
      const show = new Set<number>();
      for (const n of hits) {
        for (let k = Math.max(1, n - context); k <= Math.min(sources[where].length, n + context); k++) show.add(k);
      }
      for (const n of [...show].sort((a, b) => a - b)) rows.push({ where, line: n, match: hits.has(n) });
    }
    const labelWidth = Math.max(...rows.map((r) => `${r.where}:${r.line}`.length));
    let prev: { where: Where; line: number } | undefined;
    for (const row of rows) {
      if (context > 0 && prev && (prev.where !== row.where || row.line > prev.line + 1)) out.push("  --");
      const text = sources[row.where][row.line - 1];
      const line = row.match ? window(text, result.regex, lineChars) : text.length > lineChars ? `${text.slice(0, lineChars)}…` : text;
      out.push(`  ${`${row.where}${row.match ? ":" : "-"}${row.line}`.padEnd(labelWidth)}  ${line}`);
      prev = row;
    }
  }
  if (result.calls.length === 0) out.push("No matches.");
  if (omitted.matches > 0) {
    out.push(
      `… ${omitted.matches} more match${omitted.matches === 1 ? "" : "es"} in ${omitted.calls} call${omitted.calls === 1 ? "" : "s"} ` +
        "(narrow with tool/refs/in, or read a call with tool_ref_get and lines)",
    );
  }
  return { text: out.join("\n"), shown, omitted };
}
