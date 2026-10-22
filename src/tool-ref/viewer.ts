import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Floating, scrollable panel for `/ref` output (shown with `ctx.ui.custom(..., { overlay: true })`).
 * Scrolls by itself instead of using `ScrollView`, whose viewport comes from the layout engine.
 * Closes through `done()`; the panel never writes to the transcript.
 */

/** Overlay size; the viewer fits its height to the same fraction of the terminal. */
export const VIEWER_HEIGHT = 0.8;
export const VIEWER_OVERLAY = { width: "90%", maxHeight: "80%", anchor: "center" } as const;

/** Border top/bottom, title row, hint row. */
const CHROME_ROWS = 4;

const HINT = " ↑↓/j k scroll · PgUp/PgDn/space page · g/G top/end · q/Esc close";

export class RefViewer implements Component {
  private top = 0;
  private cache: { width: number; lines: string[] } | undefined;
  private innerWidth = 80;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly title: string;
  private readonly body: string;
  private readonly done: () => void;

  constructor(tui: TUI, theme: Theme, title: string, body: string, done: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.body = body;
    this.done = done;
  }

  private viewHeight(): number {
    return Math.max(3, Math.floor(this.tui.terminal.rows * VIEWER_HEIGHT) - CHROME_ROWS);
  }

  private lines(width: number): string[] {
    if (this.cache?.width !== width) {
      this.cache = { width, lines: this.body.split("\n").flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, width))) };
    }
    return this.cache.lines;
  }

  private maxTop(): number {
    return Math.max(0, this.lines(this.innerWidth).length - this.viewHeight());
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2);
    this.innerWidth = inner;
    const lines = this.lines(inner);
    const height = this.viewHeight();
    this.top = Math.min(this.top, this.maxTop());
    const end = Math.min(lines.length, this.top + height);

    const th = this.theme;
    const border = (s: string) => th.fg("border", s);
    const row = (s: string) => border("│") + truncateToWidth(s, inner, "", true) + border("│");
    const position = lines.length > height ? `  ${this.top + 1}-${end}/${lines.length}` : "";

    const out = [border(`╭${"─".repeat(inner)}╮`), row(th.fg("accent", ` ${this.title}`) + th.fg("dim", position))];
    for (let i = this.top; i < end; i++) out.push(row(lines[i]!));
    for (let i = end - this.top; i < height; i++) out.push(row(""));
    out.push(row(th.fg("dim", HINT)), border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    const page = this.viewHeight();
    let top = this.top;
    if (matchesKey(data, "escape") || data === "q") {
      this.done();
      return;
    } else if (matchesKey(data, "up") || data === "k") top--;
    else if (matchesKey(data, "down") || data === "j") top++;
    else if (matchesKey(data, "pageUp") || data === "b") top -= page;
    else if (matchesKey(data, "pageDown") || data === " ") top += page;
    else if (matchesKey(data, "home") || data === "g") top = 0;
    else if (matchesKey(data, "end") || data === "G") top = this.maxTop();
    else return;

    top = Math.max(0, Math.min(top, this.maxTop()));
    if (top === this.top) return;
    this.top = top;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
