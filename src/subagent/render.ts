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
 * Lines of a result row: the header and the summary's first line, then where to see the rest
 * (`/agent a3`, or a click on the row). Rows do not expand; the panel shows the whole result.
 */
export function resultRowLines(d: ResultDetails, th: Styler): string[] {
  const first = d.envelope.body.summary.split("\n", 1)[0] ?? "";
  return [headerLine(d, th), `${first} ${th.fg("dim", `· /agent ${d.resultId} for details`)}`];
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
