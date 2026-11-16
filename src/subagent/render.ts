import { DynamicBorder, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatDuration, isAbnormal, statusLabel } from "./format.ts";
import type { ResultDetails } from "./protocol.ts";

type Styler = Pick<Theme, "fg" | "bold">;

/** Header row: `[subagent] a3 · review · ok · 2m14s`, the label like codemode's (accent), the status coloured. */
export function headerLine(d: ResultDetails, th: Styler): string {
  const status = statusLabel(d);
  const color = isAbnormal(d) || d.envelope.body.status === "error" ? "error" : "success";
  return [
    th.fg("accent", th.bold("[subagent]")),
    th.bold(d.resultId),
    th.fg("muted", "·"),
    d.scenario,
    th.fg("muted", "·"),
    th.fg(color, status),
    th.fg("muted", "·"),
    th.fg("dim", formatDuration(d.endedAt - d.startedAt)),
  ].join(" ");
}

/**
 * Lines of a result row: the header, the task (one line, at most TASK_CHARS, `...` when cut), then
 * on its own line where to see the result (`/agent a3`, or a click on the row). Rows do not expand;
 * the panel shows the whole result. The model's copy (`content`) is unchanged.
 */
export function resultRowLines(d: ResultDetails, th: Styler): string[] {
  return [headerLine(d, th), capText(d.task, TASK_CHARS), "", th.fg("dim", `/agent ${d.resultId} for details`)];
}

/** Characters of the task shown in a result row. */
export const TASK_CHARS = 120;

/** `text` on one line (whitespace collapsed), cut to `max` characters with `...` when longer. */
export function capText(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 3).trimEnd()}...`;
}

/**
 * A row between two full-width rules in the theme's warning colour (amber) that opens the result's
 * panel on a left click (fullscreen mode routes mouse events).
 */
class ResultRow extends Container {
  private readonly onClick: () => void;

  constructor(text: string, paddingX: number, rule: (text: string) => string, onClick: () => void) {
    super();
    // An explicit colour function: the bundled extension must not rely on pi's global theme.
    this.addChild(new DynamicBorder(rule));
    this.addChild(new Text(text, paddingX, 0));
    this.addChild(new DynamicBorder(rule));
    this.onClick = onClick;
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.onClick();
    return { handled: true, render: false, target: { component: this, originX: 0, originY: 0, width: event.width, height: event.height } };
  }
}

/** `pi.registerMessageRenderer` renderer for `subagent-result` messages; `open` shows a result's panel. */
export function resultRenderer(open: (resultId: string) => void): MessageRenderer {
  return (message, options, theme) => {
    const d = message.details as ResultDetails | undefined;
    if (!d?.envelope) return new Text(typeof message.content === "string" ? message.content : "[subagent]", options.outputPad, 0);
    const rule = (t: string) => theme.fg("warning", t);
    return new ResultRow(resultRowLines(d, theme).join("\n"), options.outputPad, rule, () => open(d.resultId));
  };
}
