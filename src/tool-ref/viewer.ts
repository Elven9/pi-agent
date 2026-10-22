import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RefSection } from "./format.ts";
import type { Summarizer, SummaryState } from "./summary.ts";

/**
 * Floating, scrollable panel for `/ref` output (shown with `ctx.ui.custom(..., { overlay: true })`).
 * Scrolls by itself instead of using `ScrollView`, whose viewport comes from the layout engine.
 * Closes through `done()`; the panel never writes to the transcript.
 *
 * With a `Summarizer` (`toolRef.summaryModel` set), `s` switches to a summary view: one summary
 * per call, streamed in, started on first view; `r` summarizes the panel's calls again. Each
 * view keeps its own scroll position.
 */

/** Overlay size; the viewer fits its height to the same fraction of the terminal. */
export const VIEWER_HEIGHT = 0.8;
export const VIEWER_OVERLAY = { width: "90%", maxHeight: "80%", anchor: "center" } as const;

/** Border top/bottom, title row, hint row. */
const CHROME_ROWS = 4;

const HINT = " ↑↓/j k scroll · PgUp/PgDn/space page · g/G top/end · q/Esc close";

type Mode = "raw" | "summary";

export class RefViewer implements Component {
  private mode: Mode = "raw";
  private readonly tops: Record<Mode, number> = { raw: 0, summary: 0 };
  private cache: { width: number; mode: Mode; lines: string[] } | undefined;
  private innerWidth = 80;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly title: string;
  private readonly sections: RefSection[];
  private readonly summarizer: Summarizer | undefined;
  private readonly done: () => void;

  constructor(tui: TUI, theme: Theme, title: string, sections: RefSection[], summarizer: Summarizer | undefined, done: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.sections = sections;
    this.summarizer = summarizer;
    this.done = done;
  }

  private readonly onSummaryUpdate = () => {
    if (this.mode !== "summary") return;
    this.cache = undefined;
    this.tui.requestRender();
  };

  private rawBody(): string {
    return this.sections.map((s) => s.text).join("\n\n");
  }

  private summaryBody(): string {
    const th = this.theme;
    return this.sections
      .map((s) => {
        if (!s.ref || !this.summarizer) return s.text;
        const state: SummaryState | undefined = this.summarizer.get(s.ref);
        const head = `──── ${s.header} · summary ────`;
        if (!state) return `${head}\n${th.fg("dim", "(not started)")}`;
        if (state.status === "streaming") {
          return `${head}\n${state.text === "" ? th.fg("dim", `summarizing with ${this.summarizer.label}…`) : `${state.text}${th.fg("dim", " ▍")}`}`;
        }
        if (state.status === "error") {
          const partial = state.text === "" ? "" : `${state.text}\n`;
          return `${head}\n${partial}${th.fg("error", `summary failed: ${state.error}`)} ${th.fg("dim", "(r to try again)")}`;
        }
        return `${head}\n${state.text}`;
      })
      .join("\n\n");
  }

  private viewHeight(): number {
    return Math.max(3, Math.floor(this.tui.terminal.rows * VIEWER_HEIGHT) - CHROME_ROWS);
  }

  private lines(width: number): string[] {
    if (this.cache?.width !== width || this.cache.mode !== this.mode) {
      const body = this.mode === "raw" ? this.rawBody() : this.summaryBody();
      this.cache = { width, mode: this.mode, lines: body.split("\n").flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, width))) };
    }
    return this.cache.lines;
  }

  private maxTop(): number {
    return Math.max(0, this.lines(this.innerWidth).length - this.viewHeight());
  }

  private startSummaries(): void {
    for (const s of this.sections) if (s.ref) this.summarizer?.start(s.ref, this.onSummaryUpdate);
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2);
    this.innerWidth = inner;
    const lines = this.lines(inner);
    const height = this.viewHeight();
    const top = (this.tops[this.mode] = Math.min(this.tops[this.mode], this.maxTop()));
    const end = Math.min(lines.length, top + height);

    const th = this.theme;
    const border = (s: string) => th.fg("border", s);
    const row = (s: string) => border("│") + truncateToWidth(s, inner, "", true) + border("│");
    const position = lines.length > height ? `  ${top + 1}-${end}/${lines.length}` : "";
    const view = this.mode === "summary" ? ` · summary (${this.summarizer?.label})` : "";
    const hint = !this.summarizer ? HINT : this.mode === "raw" ? `${HINT} · s summary` : `${HINT} · s raw · r regenerate`;

    const out = [border(`╭${"─".repeat(inner)}╮`), row(th.fg("accent", ` ${this.title}${view}`) + th.fg("dim", position))];
    for (let i = top; i < end; i++) out.push(row(lines[i]!));
    for (let i = end - top; i < height; i++) out.push(row(""));
    out.push(row(th.fg("dim", hint)), border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.dispose();
      this.done();
      return;
    }
    if (this.summarizer && data === "s") {
      this.mode = this.mode === "raw" ? "summary" : "raw";
      if (this.mode === "summary") this.startSummaries();
      this.cache = undefined;
      this.tui.requestRender();
      return;
    }
    if (this.summarizer && this.mode === "summary" && data === "r") {
      for (const s of this.sections) if (s.ref) this.summarizer.regenerate(s.ref, this.onSummaryUpdate);
      return;
    }

    const page = this.viewHeight();
    let top = this.tops[this.mode];
    if (matchesKey(data, "up") || data === "k") top--;
    else if (matchesKey(data, "down") || data === "j") top++;
    else if (matchesKey(data, "pageUp") || data === "b") top -= page;
    else if (matchesKey(data, "pageDown") || data === " ") top += page;
    else if (matchesKey(data, "home") || data === "g") top = 0;
    else if (matchesKey(data, "end") || data === "G") top = this.maxTop();
    else return;

    top = Math.max(0, Math.min(top, this.maxTop()));
    if (top === this.tops[this.mode]) return;
    this.tops[this.mode] = top;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cache = undefined;
  }

  /** Stops summaries still streaming (they are dropped, finished ones stay cached). */
  dispose(): void {
    this.summarizer?.abort();
  }
}
