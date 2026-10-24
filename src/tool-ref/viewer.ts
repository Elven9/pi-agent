import { getLanguageFromPath, getMarkdownTheme, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, matchesKey, truncateToWidth, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RefBlock, RefSection } from "./format.ts";
import type { Summarizer, SummaryState } from "./summary.ts";

/**
 * Floating, scrollable panel for `/ref` output (shown with `ctx.ui.custom(..., { overlay: true })`).
 * Scrolls by itself instead of using `ScrollView`, whose viewport comes from the layout engine.
 * Closes through `done()`; the panel never writes to the transcript.
 *
 * One ref per page: with several refs, ←/→ (or h/l) switch between them. Each page and view
 * keeps its own scroll position.
 *
 * With a `Summarizer` (`toolRef.summaryModel` set), `s` switches to a summary view: one summary
 * of the page's call, streamed in, started on first view; `r` summarizes it again.
 *
 * The raw view highlights code blocks whose language is known (bash commands, `read` output,
 * written and edited text by file extension); everything else stays plain text. The summary
 * view renders summaries as markdown.
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
  private page = 0;
  /** Scroll position per page and view, keyed `page:mode`. */
  private readonly tops = new Map<string, number>();
  private cache: { width: number; mode: Mode; page: number; lines: string[] } | undefined;
  /** Highlighted raw body per page; it does not depend on the width. */
  private raw = new Map<number, string>();
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

  private get section(): RefSection {
    return this.sections[this.page]!;
  }

  private get top(): number {
    return this.tops.get(`${this.page}:${this.mode}`) ?? 0;
  }

  private set top(value: number) {
    this.tops.set(`${this.page}:${this.mode}`, value);
  }

  private rawBody(): string {
    let body = this.raw.get(this.page);
    if (body === undefined) {
      const s = this.section;
      body = s.blocks ? this.renderBlocks(s.blocks) : s.text;
      this.raw.set(this.page, body);
    }
    return body;
  }

  private renderBlocks(blocks: RefBlock[]): string {
    const th = this.theme;
    return blocks
      .flatMap((b) => {
        if (b.kind === "text") return [b.intent ? th.bold(th.fg("accent", b.text)) : b.text];
        const lines = highlighted(b);
        return lines.map((l, i) => (b.gutter ? th.fg("dim", b.gutter[i] ?? "") : "") + l);
      })
      .join("\n");
  }

  private summaryLines(width: number): string[] {
    const th = this.theme;
    const wrap = (text: string) => text.split("\n").flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, width)));
    const markdown = (text: string) => new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
    const s = this.section;
    if (!s.ref || !this.summarizer) return wrap(s.text);
    const state: SummaryState | undefined = this.summarizer.get(s.ref);
    const head = wrap(`──── ${s.header} · summary ────`);
    if (!state) return [...head, th.fg("dim", "(not started)")];
    if (state.status === "streaming") {
      if (state.text === "") return [...head, th.fg("dim", `summarizing with ${this.summarizer.label}…`)];
      return [...head, ...markdown(state.text), th.fg("dim", "▍")];
    }
    if (state.status === "error") {
      const partial = state.text === "" ? [] : markdown(state.text);
      return [...head, ...partial, ...wrap(`${th.fg("error", `summary failed: ${state.error}`)} ${th.fg("dim", "(r to try again)")}`)];
    }
    return [...head, ...markdown(state.text)];
  }

  private viewHeight(): number {
    return Math.max(3, Math.floor(this.tui.terminal.rows * VIEWER_HEIGHT) - CHROME_ROWS);
  }

  private lines(width: number): string[] {
    if (this.cache?.width !== width || this.cache.mode !== this.mode || this.cache.page !== this.page) {
      const lines =
        this.mode === "raw"
          ? this.rawBody()
              .split("\n")
              .flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, width)))
          : this.summaryLines(width);
      this.cache = { width, mode: this.mode, page: this.page, lines };
    }
    return this.cache.lines;
  }

  private maxTop(): number {
    return Math.max(0, this.lines(this.innerWidth).length - this.viewHeight());
  }

  /** Starts the page's summary (no-op when started or done). */
  private startSummary(): void {
    const ref = this.section.ref;
    if (ref) this.summarizer?.start(ref, this.onSummaryUpdate);
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2);
    this.innerWidth = inner;
    const lines = this.lines(inner);
    const height = this.viewHeight();
    const top = (this.top = Math.min(this.top, this.maxTop()));
    const end = Math.min(lines.length, top + height);

    const th = this.theme;
    const border = (s: string) => th.fg("border", s);
    const row = (s: string) => border("│") + truncateToWidth(s, inner, "", true) + border("│");
    const position = lines.length > height ? `  ${top + 1}-${end}/${lines.length}` : "";
    const view = this.mode === "summary" ? ` · summary (${this.summarizer?.label})` : "";
    const many = this.sections.length > 1;
    const pager = many ? ` · ‹ ${this.page + 1}/${this.sections.length} › ${this.section.header ?? `#${this.section.handle}`}` : "";
    const base = many ? ` ←→/h l ref ·${HINT}` : HINT;
    const hint = !this.summarizer ? base : this.mode === "raw" ? `${base} · s summary` : `${base} · s raw · r regenerate`;

    const out = [border(`╭${"─".repeat(inner)}╮`), row(th.fg("accent", ` ${this.title}${pager}${view}`) + th.fg("dim", position))];
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
      if (this.mode === "summary") this.startSummary();
      this.cache = undefined;
      this.tui.requestRender();
      return;
    }
    if (this.summarizer && this.mode === "summary" && data === "r") {
      const ref = this.section.ref;
      if (ref) this.summarizer.regenerate(ref, this.onSummaryUpdate);
      return;
    }
    const step = matchesKey(data, "left") || data === "h" ? -1 : matchesKey(data, "right") || data === "l" ? 1 : 0;
    if (step !== 0) {
      const next = Math.max(0, Math.min(this.sections.length - 1, this.page + step));
      if (next === this.page) return;
      this.page = next;
      if (this.mode === "summary") this.startSummary();
      this.cache = undefined;
      this.tui.requestRender();
      return;
    }

    const page = this.viewHeight();
    let top = this.top;
    if (matchesKey(data, "up") || data === "k") top--;
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
    // Also after a theme change: the highlighting depends on the theme.
    this.cache = undefined;
    this.raw.clear();
  }

  /** Stops summaries still streaming (they are dropped, finished ones stay cached). */
  dispose(): void {
    this.summarizer?.abort();
  }
}

/** Code lines highlighted when their language is known, else as they are. */
function highlighted(block: Extract<RefBlock, { kind: "code" }>): string[] {
  const lang = block.lang ?? (block.file ? getLanguageFromPath(block.file) : undefined);
  if (!lang) return block.lines;
  const lines = highlightCode(block.lines.join("\n"), lang);
  // Line numbers in the gutter must stay aligned with the code.
  return lines.length === block.lines.length ? lines : block.lines;
}
