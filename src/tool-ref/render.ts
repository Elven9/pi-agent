import { highlightCode, keyHint, type Theme, type ToolRendererResolver, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { parseHandle, withoutTrailer } from "../shared/tool-ref.ts";
import { oneLine, scriptStart } from "./format.ts";

/**
 * Hides the trailer when tool results are drawn; the session file and the model keep it.
 *
 * pi uses the renderer set of the first resolver, so this returns `next()` with `renderResult`
 * wrapped to receive the content without the trailer block. Live results come from
 * `tool_execution_end` (no trailer yet); results loaded from the session have one.
 *
 * - No `renderResult` in `next()`: pi would draw its text fallback, which is not exported, so
 *   a close copy is supplied. Not for built-in tools: in the interactive UI `next()` always has
 *   their renderers, and in the HTML export (bare definitions) the template draws built-in
 *   tools itself, which a `renderResult` would replace. The export shows the trailer there.
 * - `next()` undefined (no definition, e.g. an MCP tool not connected yet): left to pi, which
 *   then shows the trailer.
 */

/** Tools pi has built-in renderers for (`createAllToolRenderers`). */
const BUILTIN_RENDERED = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const PREVIEW_LINES = 10;

type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type Result = Parameters<RenderResult>[0];

function stripped(result: Result): Result {
  const content = withoutTrailer(result.content ?? []);
  return content === result.content ? result : { ...result, content };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** `keyHint` reads pi's global theme, which only interactive mode sets up. */
function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "to expand";
  }
}

/** Close copy of pi's `createResultFallback`: text output, first lines, expand hint. Images are drawn by pi. */
export const fallbackResult: RenderResult = (result, options, theme: Theme) => {
  const output = (result.content ?? [])
    .flatMap((c) => (c.type === "text" ? [(c.text ?? "").replace(ANSI, "").replace(/\r/g, "")] : []))
    .join("\n");
  if (!output) return new Text("", 0, 0);
  const lines = output.split("\n");
  const shown = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const remaining = lines.length - shown.length;
  let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (remaining > 0) text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${expandHint()}${theme.fg("muted", ")")}`;
  return new Text(text, 0, 0);
};

export const hideTrailer: ToolRendererResolver = (toolName, next) => {
  const base = next();
  if (!base) return undefined;
  const inner = base.renderResult;
  if (inner) return { ...base, renderResult: (result, options, theme, context) => inner(stripped(result), options, theme, context) };
  if (BUILTIN_RENDERED.has(toolName)) return base;
  return { ...base, renderResult: (result, options, theme, context) => fallbackResult(stripped(result), options, theme, context) };
};

// --- Compact codemode rows ---------------------------------------------------------------

const CODEMODE = "codemode";
const INTENT = /^\/\/\s*intent:\s*(\S.*)$/;

/** The script's `// intent:` line (first line, or right after `// @options:`), else undefined. */
export function scriptIntent(code: string): string | undefined {
  const first = scriptStart(code).split("\n", 1)[0].trim();
  return INTENT.exec(first)?.[1].trim();
}

/** `850ms`, `1.2s`, `2m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export interface RowData {
  handle?: number;
  durationMs?: number;
}

/**
 * Handle and duration of codemode rows by tool call id, for the compact call line. Live rows
 * are drawn from `tool_execution_end`, before `message_end` assigns the handle, so the
 * extension sets it here afterwards and the row is redrawn. Resumed sessions are filled from
 * the branch index; a saved result's trailer fills it too (`renderResult`).
 */
export class RowStore {
  private rows = new Map<string, RowData>();
  private redraw = new Map<string, () => void>();

  clear(): void {
    this.rows.clear();
    this.redraw.clear();
  }

  get(toolCallId: string): RowData {
    return this.rows.get(toolCallId) ?? {};
  }

  /** Merges `data` in; redraws the row (later, never inside a render) when something changed. */
  set(toolCallId: string, data: RowData): void {
    const old = this.get(toolCallId);
    const merged = { ...old, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
    if (merged.handle === old.handle && merged.durationMs === old.durationMs) return;
    this.rows.set(toolCallId, merged);
    const redraw = this.redraw.get(toolCallId);
    if (redraw) queueMicrotask(redraw);
  }

  /** The row's redraw function (`context.invalidate`), kept from its latest render. */
  watch(toolCallId: string, invalidate: () => void): void {
    this.redraw.set(toolCallId, invalidate);
  }
}
/** One terminal line, cut to the width (the intent can be long). */
class Line implements Component {
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width))];
  }
  invalidate(): void {}
}

/** The script of codemode arguments (also partial ones while streaming). */
function scriptCode(args: unknown): string {
  const code = (args as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "";
}

function highlighted(code: string): string {
  const clean = code.replace(/\r/g, "").replace(/\t/g, "   ").trimEnd();
  try {
    return highlightCode(clean, "javascript").join("\n");
  } catch {
    return clean; // no theme set up (tests)
  }
}

/**
 * The tool name as a highlighted label: `[codemode]`, bold in the accent color. No background:
 * a background closes with the terminal default (`\x1b[49m`), not the row box's background,
 * so the rest of the line would sit on a different color.
 */
export function toolLabel(theme: Theme): string {
  return theme.fg("accent", theme.bold(`[${CODEMODE}]`));
}

/**
 * The metadata line's items: handle, duration, error mark. Empty while nothing is known (a
 * running row has no handle or duration yet). Add new metadata here.
 */
export function rowMetadata(row: RowData, durationMs: number | undefined, isError: boolean, theme: Theme): string[] {
  const items: string[] = [];
  if (row.handle !== undefined) items.push(theme.fg("accent", `#${row.handle}`));
  if (durationMs !== undefined) items.push(theme.fg("dim", formatDuration(durationMs)));
  if (isError) items.push(theme.fg("error", "failed"));
  return items;
}

/**
 * codemode rows as a short header:
 *
 *     [codemode] <intent>
 *
 *     #12 · 0.1s
 *
 * The metadata line (and the empty line before it) only appears once there is metadata.
 * Collapsed, the header is the whole row; expanded (click the row, or ctrl+o for all), the
 * script and pi's own result view (nested calls, output) follow. The call line is never expanded in the HTML export, where the
 * result part is the clickable one, so the script lives in the expanded result, not the call.
 */
export function compactCodemode(base: ToolRenderers, rows: RowStore): ToolRenderers {
  const inner = base.renderResult;
  return {
    ...base,
    renderCall(args, theme, context) {
      rows.watch(context.toolCallId, context.invalidate);
      const code = scriptCode(args);
      const row = rows.get(context.toolCallId);
      const durationMs = context.durationMs ?? row.durationMs;
      const intent = scriptIntent(code) ?? theme.fg("muted", oneLine(scriptStart(code), 200));
      const header = new Container();
      header.addChild(new Line(`${toolLabel(theme)} ${intent}`));
      const metadata = rowMetadata(row, durationMs, context.isError, theme);
      if (metadata.length > 0) {
        header.addChild(new Line(""));
        header.addChild(new Line(metadata.join(theme.fg("dim", " · "))));
      }
      return header;
    },
    renderResult(result, options, theme, context) {
      const handle = parseHandle(result.content);
      if (handle !== undefined) rows.set(context.toolCallId, { handle });
      const component = new Container();
      if (!options.expanded) return component;
      const code = scriptCode(context.args);
      if (code) component.addChild(new Text(highlighted(code), 0, 0));
      if (inner) {
        component.addChild(new Spacer(1));
        component.addChild(inner(result, options, theme, { ...context, lastComponent: undefined }));
      }
      return component;
    },
  };
}

/** tool-ref's renderer: trailer hidden everywhere, codemode rows compact. */
export function toolRefRenderer(rows: RowStore): ToolRendererResolver {
  return (toolName, next) => {
    const set = hideTrailer(toolName, next);
    return toolName === CODEMODE && set ? compactCodemode(set, rows) : set;
  };
}
