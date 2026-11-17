import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/** Widget key of the upload spinner. */
export const PROGRESS_WIDGET = "session-upload";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 100;

/** Seconds with one decimal: `1.2s`. */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** The progress line: spinner frame and elapsed time. */
export function progressLine(elapsedMs: number): string {
  return `${FRAMES[Math.floor(elapsedMs / TICK_MS) % FRAMES.length]} Uploading session… ${seconds(elapsedMs)}`;
}

export interface Progress {
  /** Stops the spinner and removes it; returns the elapsed milliseconds. */
  stop(): number;
}

export interface ProgressOptions {
  now?: () => number;
  /** Where the terminal line goes when the TUI is gone (quit); default process.stderr. */
  stream?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
}

/**
 * Shows an upload in progress, elapsed time only (one request, no byte progress):
 * - `widget`: a spinner widget above the editor (TUI running: /upload, /new, /resume, /fork),
 * - `terminal`: a line on stderr redrawn in place (quit: pi stops the TUI before
 *   session_shutdown), only on a TTY,
 * - `none`: nothing (no UI).
 */
export function startProgress(ctx: ExtensionContext, where: "widget" | "terminal" | "none", opts: ProgressOptions = {}): Progress {
  const now = opts.now ?? Date.now;
  const start = now();
  if (where === "widget" && ctx.hasUI) {
    ctx.ui.setWidget(PROGRESS_WIDGET, (tui: TUI, theme: Theme) => spinnerWidget(tui, theme, () => now() - start));
    return {
      stop: () => {
        ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
        return now() - start;
      },
    };
  }
  const stream = opts.stream ?? process.stderr;
  if (where === "terminal" && stream.isTTY) {
    const draw = () => void stream.write(`\r\x1b[2K${progressLine(now() - start)}`);
    draw();
    const timer = setInterval(draw, TICK_MS);
    return {
      stop: () => {
        clearInterval(timer);
        stream.write("\r\x1b[2K");
        return now() - start;
      },
    };
  }
  return { stop: () => now() - start };
}

function spinnerWidget(tui: TUI, theme: Theme, elapsed: () => number): Component & { dispose(): void } {
  const timer = setInterval(() => tui.requestRender(), TICK_MS);
  return {
    render: (width) => [truncateToWidth(theme.fg("muted", progressLine(elapsed())), width)],
    invalidate: () => {},
    dispose: () => clearInterval(timer),
  };
}
