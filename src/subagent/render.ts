import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { formatDuration, isAbnormal, statusLabel } from "./format.ts";
import type { ResultDetails } from "./protocol.ts";

type Styler = Pick<Theme, "fg" | "bold">;

/** Header row: `[subagent] a3 · review · ok · 2m14s`, the label warm, the status coloured. */
export function headerLine(d: ResultDetails, th: Styler): string {
  const status = statusLabel(d);
  const color = isAbnormal(d) || d.envelope.body.status === "error" ? "error" : "success";
  return [
    th.bold(th.fg("warning", "[subagent]")),
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
 * Lines of a result row: the header and the summary's first line, then where to see the rest
 * (`/agent a3`, or a click on the row). Rows do not expand; the panel shows the whole result.
 */
export function resultRowLines(d: ResultDetails, th: Styler): string[] {
  const first = d.envelope.body.summary.split("\n", 1)[0] ?? "";
  return [headerLine(d, th), `${first} ${th.fg("dim", `· /agent ${d.resultId} for details`)}`];
}

/** A row that opens the result's panel on a left click (fullscreen mode routes mouse events). */
class ResultRow extends Text {
  private readonly onClick: () => void;

  constructor(text: string, paddingX: number, onClick: () => void) {
    super(text, paddingX, 0);
    this.onClick = onClick;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.onClick();
    return { handled: true, render: false };
  }
}

/** `pi.registerMessageRenderer` renderer for `subagent-result` messages; `open` shows a result's panel. */
export function resultRenderer(open: (resultId: string) => void): MessageRenderer {
  return (message, options, theme) => {
    const d = message.details as ResultDetails | undefined;
    if (!d?.envelope) return new Text(typeof message.content === "string" ? message.content : "[subagent]", options.outputPad, 0);
    return new ResultRow(resultRowLines(d, theme).join("\n"), options.outputPad, () => open(d.resultId));
  };
}
