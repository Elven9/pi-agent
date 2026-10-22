import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { ENTRY, TOOL_RESULT_REWRITER_CHANNEL, type ToolResultRewriterAnnounced } from "../shared/protocol.ts";
import { parseHandle, trailerText } from "../shared/tool-ref.ts";
import { HandleCounter } from "./counter.ts";
import {
  DEFAULT_MAX_CHARS,
  formatGetMany,
  formatGrep,
  formatRefView,
  grepRefs,
  MAX_REFS,
  parseRefArgs,
  type GetOptions,
  type GrepOptions,
} from "./format.ts";
import { hideTrailer } from "./render.ts";
import { indexBranch, loadSettings, TOOL_REF_GET, TOOL_REF_GREP, type ToolRefSettings } from "./resolver.ts";

/**
 * tool-ref extension: every tool result gets a short handle (`[tool-ref #12]`, its own text
 * block at the end of the content), and two read-only tools look calls up by handle
 * (`tool_ref_get`) or by regex (`tool_ref_grep`). Data comes from the raw session entries of
 * the active branch, so compaction and context edits hide nothing. See
 * docs/tool-ref-design.md.
 *
 * Load order: last, at least after every extension whose `message_end` handler replaces
 * tool results (they could drop the trailer). Checked for pi-agent extensions: they announce
 * themselves on TOOL_RESULT_REWRITER_CHANNEL from their session_start; handlers run in load
 * order, so an announcement after this extension's session_start means that extension loaded
 * later. That is an error (entry + shutdown), like the scenario-profile/project check.
 */

/** Constant (no session data), so the system prompt stays cacheable. */
export const GUIDELINES = [
  "Every tool result ends with `[tool-ref #N]`. Cite evidence by number, not by copying output.",
  "To see earlier results again, use `tool_ref_get` (with `lines`) instead of re-running the command.",
  "To find earlier calls, e.g. after context was summarized, use `tool_ref_grep`.",
];

function stringEnum<T extends string>(values: readonly T[], options: { description?: string } = {}) {
  return Type.Unsafe<T>({ type: "string", enum: [...values], ...options });
}

const handles = (what: string) =>
  Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: MAX_REFS, description: `${what} (at most ${MAX_REFS})` });

const GET_PARAMETERS = Type.Object({
  refs: handles("Handles to show, e.g. [12, 14]"),
  part: Type.Optional(stringEnum(["output", "input", "both"] as const, { description: "What to show (default: output)" })),
  lines: Type.Optional(
    Type.Array(Type.Integer(), {
      minItems: 2,
      maxItems: 2,
      description: "Output line range, 1-based and inclusive, e.g. [1, 80]; negative counts from the end, e.g. [-50, -1]",
    }),
  ),
  maxChars: Type.Optional(Type.Integer({ minimum: 100, description: `Characters per ref (default ${DEFAULT_MAX_CHARS})` })),
});

const GREP_PARAMETERS = Type.Object({
  pattern: Type.String({
    description: "JavaScript regex, matched line by line; case-insensitive unless it has an uppercase letter",
  }),
  in: Type.Optional(stringEnum(["input", "output", "both"] as const, { description: "Where to search (default: both)" })),
  refs: Type.Optional(handles("Search only these handles")),
  tool: Type.Optional(Type.Array(Type.String(), { description: "Only calls of these tools" })),
  errors: Type.Optional(Type.Boolean({ description: "true: only failed calls; false: only successful ones" })),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Lines of context around each match (default 0)" })),
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export default function toolRef(pi: ExtensionAPI) {
  let settings: ToolRefSettings = loadSettings(undefined);
  const counter = new HandleCounter();

  /** Set by this extension's session_start; a rewriter announcing after it loaded later. */
  let started: ExtensionContext | undefined;
  pi.events.on(TOOL_RESULT_REWRITER_CHANNEL, (data) => {
    if (!started) return;
    const { name } = data as ToolResultRewriterAnnounced;
    const message =
      `The tool-ref extension must load after ${name}, whose message_end handler replaces tool results ` +
      "and would drop the [tool-ref #N] trailers (list tool-ref last in -e flags or the package manifest).";
    // Startup entries are not streamed in --mode json, so also tell stderr.
    console.error(`[pi-agent] ${message}`);
    pi.appendEntry(ENTRY.error, { message });
    started.shutdown();
  });

  pi.on("session_start", (_event, ctx) => {
    // Read here, so a change applies after /reload.
    settings = loadSettings(pi.getSettings());
    counter.init(ctx.sessionManager);
    started = ctx;
  });

  // Every result message, whatever produced it (tool, block, validation error, length cut),
  // goes through message_end before it is saved and before the next model request.
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "toolResult") return;
    if (parseHandle(message.content) !== undefined) return;
    const n = counter.take(ctx.sessionManager);
    return { message: { ...message, content: [...message.content, { type: "text", text: trailerText(n) }] } };
  });

  // Display only: the trailer is hidden in the interactive UI, kept in the session and the context.
  pi.registerToolRenderer(hideTrailer);

  const index = (ctx: ExtensionContext) =>
    indexBranch(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId(), settings.exclude);

  // For the user: the original input and output of calls by handle, excluded ones included.
  pi.registerCommand("ref", {
    description: "Show the original input and output of tool calls by handle: /ref 12 [14 ...]",
    handler: async (args, ctx) => {
      let refs: number[];
      try {
        refs = parseRefArgs(args);
      } catch (err) {
        ctx.ui.notify((err as Error).message, "error");
        return;
      }
      ctx.ui.notify(formatRefView(index(ctx), refs), "info");
    },
  });

  pi.registerTool({
    name: TOOL_REF_GET,
    label: "Tool ref: get",
    description:
      "Show earlier tool results by their handle (the N of `[tool-ref #N]`): output, input or both. " +
      "Output lines are numbered; use `lines` for a range and `maxChars` to see more.",
    promptGuidelines: GUIDELINES,
    parameters: GET_PARAMETERS,
    exposure: "direct",
    annotations: { readOnlyHint: true },
    async execute(_id, params: { refs: number[] } & GetOptions, _signal, _onUpdate, ctx) {
      const { text: out, results } = formatGetMany(index(ctx), params.refs, params);
      return { ...text(out), details: { results } };
    },
  } satisfies ToolDefinition<TSchema>);

  pi.registerTool({
    name: TOOL_REF_GREP,
    label: "Tool ref: grep",
    description:
      "Find earlier tool calls by regex over their input and output, newest first, with line numbers " +
      "for tool_ref_get. `pattern: \".\", in: \"input\"` lists the calls.",
    parameters: GREP_PARAMETERS,
    exposure: "direct",
    annotations: { readOnlyHint: true },
    // Models sometimes pass a single tool name as a string.
    prepareArguments(args) {
      const a = (args ?? {}) as Record<string, unknown>;
      return (typeof a.tool === "string" ? { ...a, tool: [a.tool] } : a) as any;
    },
    async execute(_id, params: GrepOptions, _signal, _onUpdate, ctx) {
      const result = grepRefs(index(ctx), params);
      const { text: out, shown, omitted } = formatGrep(result, { context: params.context });
      return { ...text(out), details: { calls: shown, omitted } };
    },
  } satisfies ToolDefinition<TSchema>);
}
