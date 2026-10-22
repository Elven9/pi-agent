import { keyHint, type Theme, type ToolRendererResolver, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { withoutTrailer } from "../shared/tool-ref.ts";

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
