import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatDuration, isAbnormal, resultLines, statusLabel } from "./format.ts";
import type { ResultDetails } from "./protocol.ts";

type Styler = Pick<Theme, "fg" | "bold">;

/** Header row: `[subagent] a3 · review · ok · 2m14s`, the status coloured. */
export function headerLine(d: ResultDetails, th: Styler): string {
  const status = statusLabel(d);
  const color = isAbnormal(d) ? "error" : d.envelope.body.status === "error" ? "warning" : "success";
  return [
    th.fg("accent", "[subagent]"),
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
 * Lines of a result row. Collapsed: header and the summary's first line. Expanded: header, then
 * the full result (task, summary, detail).
 */
export function resultRowLines(d: ResultDetails, expanded: boolean, th: Styler, expandHint?: string): string[] {
  const header = headerLine(d, th);
  if (expanded) return [header, ...resultLines(d).map((l) => th.fg("muted", l))];
  const summary = d.envelope.body.summary.split("\n");
  const more = summary.length > 1 || d.envelope.body.detail !== undefined;
  return [header, summary[0] + (more && expandHint ? ` ${th.fg("dim", `(${expandHint})`)}` : "")];
}

/** `pi.registerMessageRenderer` renderer for `subagent-result` messages. */
export const resultRenderer: MessageRenderer = (message, options, theme) => {
  const d = message.details as ResultDetails | undefined;
  if (!d?.envelope) return new Text(typeof message.content === "string" ? message.content : "[subagent]", options.outputPad, 0);
  const hint = options.keyHint?.("app.tools.expand", "to expand");
  return new Text(resultRowLines(d, options.expanded, theme, hint).join("\n"), options.outputPad, 0);
};
