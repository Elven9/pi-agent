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
const CODEMODE = "codemode";

/** Most characters of output per ref (`get`) and of match text in total (`grep`) in structured results. */
export const STRUCTURED_MAX_CHARS = 1_048_576;
/** `grep` caps for structured results (scripts filter themselves; the text caps are for the model). */
export const GREP_STRUCTURED_PER_CALL = 50;
export const GREP_STRUCTURED_TOTAL = 1000;

/**
 * Provenance line for a result whose tool looked up earlier results (a codemode script calling
 * tool-ref tools): `looked up: #12 #14, grep /error/`. Undefined without lookups.
 */
export function lookupSummary(ref: Pick<ToolRef, "lookups">): string | undefined {
  if (!ref.lookups?.length) return undefined;
  const handles = (refs: number[]) => refs.map((n) => `#${n}`).join(" ");
  const parts = ref.lookups.map((l) => {
    if (l.tool === "tool_ref_get") return l.refs ? handles(l.refs) : "get (arguments not recorded)";
    const grep = l.pattern !== undefined ? `grep /${l.pattern}/` : "grep (arguments not recorded)";
    return l.refs ? `${grep} in ${handles(l.refs)}` : grep;
  });
  return `looked up: ${parts.join(", ")}`;
}

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

/**
 * A codemode script without its `// @options:` line and leading blank lines, so the summary
 * starts with code.
 */
export function scriptStart(code: string): string {
  return code.replace(/^\s*\/\/\s*@options:[^\n]*\n?/, "").replace(/^\s*\n/, "").trimStart();
}

/** One-line input summary: `bash` command, `read`/`edit`/`write` path, codemode script, else compact JSON. */
export function inputSummary(ref: Pick<ToolRef, "toolName" | "input">): string {
  const input = ref.input;
  if (!input) return "(call not found)";
  if (ref.toolName === "bash" && typeof input.command === "string") return oneLine(input.command);
  if (ref.toolName === CODEMODE && typeof input.code === "string") return oneLine(scriptStart(input.code));
  if (PATH_TOOLS.has(ref.toolName) && typeof input.path === "string") return oneLine(input.path);
  return oneLine(JSON.stringify(input));
}

/** The code of a call whose input is just its code (`bash` command, codemode script), else undefined. */
function soleCode(ref: Pick<ToolRef, "toolName" | "input">): string | undefined {
  const input = ref.input;
  if (!input || Object.keys(input).length !== 1) return undefined;
  const value = ref.toolName === "bash" ? input.command : ref.toolName === CODEMODE ? input.code : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * Input as lines (`in:N` in grep): a `bash` command or codemode script as is (so `in:N` is its
 * own line number), otherwise one `key: value` per argument, strings raw (multi-line strings
 * continue on the next lines), others as JSON.
 */
export function inputLines(ref: Pick<ToolRef, "toolName" | "input">): string[] {
  const input = ref.input;
  if (!input) return [];
  const code = soleCode(ref);
  if (code !== undefined) return code.split("\n");
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
  const lookups = lookupSummary(ref);
  if (part === "output") {
    out.push(`#${ref.handle} ${ref.toolName} ${status(ref)} · input: ${inputSummary(ref)}`);
    if (lookups) out.push(lookups);
  } else {
    out.push(`#${ref.handle} ${ref.toolName} ${status(ref)}`);
    if (lookups) out.push(lookups);
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

/** One ref of `tool_ref_get`'s structured result (what codemode scripts receive). */
export type GetItem = {
  handle: number;
  toolName: string;
  toolCallId: string;
  isError: boolean;
  /** Original arguments; null when not asked for (`part: "output"`) or the call is not found. */
  input: Record<string, unknown> | null;
  /** Whole text output (images as `[image]`), or the `lines` range; null for `part: "input"`. */
  output: string | null;
  /** Set when `lines` was given: the range returned and the total. */
  lines?: { from: number; to: number; total: number };
  /** Output cut at STRUCTURED_MAX_CHARS. */
  truncated?: true;
  /** tool-ref lookups the call made (codemode scripts). */
  lookups?: ToolRef["lookups"];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
};

export type GetItemResult = GetItem | { handle: number; error: string };

/**
 * Structured `tool_ref_get`: raw data for scripts, no `maxChars` and no line numbers; `lines`
 * selects a range. Output is capped at STRUCTURED_MAX_CHARS per ref. Per-ref errors inline.
 */
export function getStructured(index: ToolRefIndex, refs: number[], options: Omit<GetOptions, "maxChars"> = {}): { results: GetItemResult[] } {
  const part = options.part ?? "output";
  const results: GetItemResult[] = [];
  for (const n of new Set(refs)) {
    const r = resolveHandle(index, n);
    if (r.error !== undefined) {
      results.push({ handle: n, error: r.error });
      continue;
    }
    const ref = r.ref;
    const item: GetItem = {
      handle: n,
      toolName: ref.toolName,
      toolCallId: ref.toolCallId,
      isError: ref.isError,
      input: part === "output" ? null : (ref.input ?? null),
      output: null,
    };
    if (part !== "input") {
      let output = ref.output;
      if (options.lines) {
        const { lines } = outputLines(ref);
        const total = lines.length;
        const at = (k: number) => (k < 0 ? total + 1 + k : k);
        const from = Math.max(1, at(options.lines[0]));
        const to = Math.min(total, at(options.lines[1]));
        if (from > to) {
          results.push({ handle: n, error: `#${n}: output lines ${options.lines[0]}..${options.lines[1]} are outside 1-${total}` });
          continue;
        }
        output = lines.slice(from - 1, to).join("\n");
        item.lines = { from, to, total };
      }
      if (output.length > STRUCTURED_MAX_CHARS) {
        output = output.slice(0, STRUCTURED_MAX_CHARS);
        item.truncated = true;
      }
      item.output = output;
    }
    if (ref.lookups.length > 0) item.lookups = ref.lookups;
    if (ref.startedAt) item.startedAt = ref.startedAt;
    if (ref.endedAt) item.endedAt = ref.endedAt;
    if (ref.durationMs !== undefined) item.durationMs = ref.durationMs;
    results.push(item);
  }
  return { results };
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
  return refViewSections(index, refs)
    .map((s) => s.text)
    .join("\n\n");
}

/**
 * A piece of a `/ref` section. `code` lines may be highlighted by the viewer: `lang` names the
 * language, `file` lets it derive one from the file extension; with neither (or an unknown
 * extension) they stay plain text. `gutter` holds per-line prefixes (output line numbers) that
 * are kept out of the highlighting.
 */
export type RefBlock =
  | { kind: "text"; text: string }
  | { kind: "code"; lines: string[]; lang?: string; file?: string; gutter?: string[] };

/** One `/ref` section: a resolved call (`ref`, `header`, `blocks`) or an error line (`text` only). */
export interface RefSection {
  handle: number;
  ref?: ToolRef & { handle: number };
  /** `#N tool ok|ERR`, for resolved calls. */
  header?: string;
  /** Plain text of the section (`blocks` joined, for resolved calls). */
  text: string;
  blocks?: RefBlock[];
}

/** Plain text of `/ref` blocks, one line per text block and code line. */
export function refBlocksText(blocks: RefBlock[]): string {
  return blocks
    .flatMap((b) => (b.kind === "text" ? [b.text] : b.lines.map((l, i) => `${b.gutter?.[i] ?? ""}${l}`)))
    .join("\n");
}

const textBlock = (text: string): RefBlock => ({ kind: "text", text });

/** `/ref` input: code-like arguments (bash command, written content, edit texts) as code blocks. */
function refInputBlocks(ref: ToolRef): RefBlock[] {
  const input = ref.input;
  if (!input) return [textBlock("input:"), textBlock("(call not found)")];
  const blocks: RefBlock[] = [textBlock("input:")];
  const file = typeof input.path === "string" ? input.path : undefined;
  const sole = soleCode(ref);
  if (sole !== undefined) {
    blocks.push({ kind: "code", lines: sole.split("\n"), lang: ref.toolName === "bash" ? "bash" : "javascript" });
    return blocks;
  }
  const code = (label: string, value: string, source: { lang?: string; file?: string }) =>
    blocks.push(textBlock(`${label}:`), { kind: "code", lines: value.split("\n"), ...source });
  for (const [key, value] of Object.entries(input)) {
    if (ref.toolName === "bash" && key === "command" && typeof value === "string") code(key, value, { lang: "bash" });
    else if (ref.toolName === CODEMODE && key === "code" && typeof value === "string") code(key, value, { lang: "javascript" });
    else if (ref.toolName === "write" && key === "content" && typeof value === "string") code(key, value, { file });
    else if (ref.toolName === "edit" && key === "edits" && Array.isArray(value) && value.every(isEdit)) {
      value.forEach((e, i) => {
        code(`edits[${i}].oldText`, e.oldText, { file });
        code(`edits[${i}].newText`, e.newText, { file });
      });
    } else {
      for (const line of `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`.split("\n")) blocks.push(textBlock(line));
    }
  }
  return blocks;
}

function isEdit(e: unknown): e is { oldText: string; newText: string } {
  return typeof e === "object" && e !== null && typeof (e as any).oldText === "string" && typeof (e as any).newText === "string";
}

/** A closing `[...]` notice after a blank line, as `read` appends (`[Showing lines ...]`). */
const NOTICE = /^\[.*\]$/;

/** `/ref` output: numbered lines; a successful `read` is code in the language of its file. */
function refOutputBlocks(ref: ToolRef): RefBlock[] {
  const { lines, image } = outputLines(ref);
  const total = lines.length;
  if (total === 0) return [textBlock("output: (none)")];
  const width = String(total).length;
  const gutter = lines.map((_, i) => `${String(i + 1).padStart(width)}  `);
  const path = ref.input?.path;
  const file = ref.toolName === "read" && !ref.isError && typeof path === "string" && !image.includes(true) ? path : undefined;
  const blocks: RefBlock[] = [textBlock(`output (${total} line${total === 1 ? "" : "s"}):`)];
  // A trailing notice is not part of the file: keep it out of the highlighted block.
  let end = total;
  if (file && total >= 3 && NOTICE.test(lines[total - 1]!) && lines[total - 2] === "") end = total - 2;
  blocks.push({ kind: "code", lines: lines.slice(0, end), gutter: gutter.slice(0, end), file });
  if (end < total) blocks.push({ kind: "code", lines: lines.slice(end), gutter: gutter.slice(end) });
  return blocks;
}

/** `/ref` text per handle (duplicates dropped), in the given order. */
export function refViewSections(index: ToolRefIndex, refs: number[]): RefSection[] {
  const sections: RefSection[] = [];
  for (const n of new Set(refs)) {
    const r = resolveHandle(index, n, { allowExcluded: true });
    if (r.error !== undefined) {
      sections.push({ handle: n, text: r.error });
      continue;
    }
    const ref = r.ref as ToolRef & { handle: number };
    const facts = [
      `call ${ref.toolCallId}`,
      ref.startedAt && `started ${ref.startedAt}`,
      ref.durationMs !== undefined && `${ref.durationMs} ms`,
      `entry ${ref.entryId}`,
      ref.excluded && "excluded from tool_ref_get/grep",
      lookupSummary(ref),
    ].filter(Boolean);
    // Whole input and output (no character cap); a blank line between parts.
    const header = `#${ref.handle} ${ref.toolName} ${status(ref)}`;
    const blocks: RefBlock[] = [
      textBlock(`──── ${header} ────`),
      textBlock(facts.join(" · ")),
      textBlock(""),
      ...refInputBlocks(ref),
      textBlock(""),
      ...refOutputBlocks(ref),
    ];
    sections.push({ handle: n, ref, header, text: refBlocksText(blocks), blocks });
  }
  return sections;
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

/**
 * Finds calls on the active branch whose input or output lines match. Excluded calls and
 * lookup-only scripts (`ref.lookupOnly`) are skipped silently unless asked for by `refs`.
 * `tool` also matches scripts that called that tool (`ref.nestedTools`).
 */
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
    // Lookup-only scripts contain the patterns and handles they looked up: noise, like tool-ref's own results.
    candidates = index.refs.filter((r) => !r.excluded && !r.lookupOnly).reverse();
  }
  const calls: GrepCall[] = [];
  for (const ref of candidates) {
    if (tools && !tools.has(ref.toolName) && !ref.nestedTools.some((t) => tools.has(t))) continue;
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
    const lookups = lookupSummary(ref);
    out.push(`${handleText(ref).padEnd(handleWidth)} ${ref.toolName} ${status(ref).padEnd(3)}  ${inputSummary(ref)}${lookups ? ` · ${lookups}` : ""}`);
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

/** One call of `tool_ref_grep`'s structured result. */
export type GrepItem = {
  /** null when the result has no usable handle (none, or ambiguous). */
  handle: number | null;
  toolName: string;
  isError: boolean;
  /** Matching lines (1-based), whole; input first. */
  matches: Array<{ where: "input" | "output"; line: number; text: string }>;
};

/**
 * Structured `tool_ref_grep`: whole matching lines, no context. Caps: `perCall` matches per
 * call, `total` in all, and STRUCTURED_MAX_CHARS of match text; `omitted` counts the rest.
 */
export function grepStructured(
  result: GrepResult,
  options: { perCall?: number; total?: number; maxChars?: number } = {},
): { calls: GrepItem[]; omitted: number; notes: string[] } {
  const perCall = options.perCall ?? GREP_STRUCTURED_PER_CALL;
  let left = options.total ?? GREP_STRUCTURED_TOTAL;
  let chars = options.maxChars ?? STRUCTURED_MAX_CHARS;
  const calls: GrepItem[] = [];
  let omitted = 0;
  for (const call of result.calls) {
    const { ref } = call;
    const sources: Record<Where, string[]> = { in: inputLines(ref), out: outputLines(ref).lines };
    const matches: GrepItem["matches"] = [];
    for (const m of call.matches) {
      const text = sources[m.where][m.line - 1] ?? "";
      if (matches.length >= perCall || left === 0 || text.length > chars) {
        omitted++;
        continue;
      }
      matches.push({ where: m.where === "in" ? "input" : "output", line: m.line, text });
      left--;
      chars -= text.length;
    }
    if (matches.length > 0) {
      calls.push({ handle: ref.ambiguous || ref.handle === undefined ? null : ref.handle, toolName: ref.toolName, isError: ref.isError, matches });
    }
  }
  return { calls, omitted, notes: result.notes };
}
