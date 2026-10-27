import { highlightCode } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { VIEWER_HEIGHT } from "../tool-ref/viewer.ts";
import { blockBStart, contextHeader, type ContextView, inBlockB, NOT_BUILT_NOTE, SEPARATOR, tokens } from "./format.ts";
import { type CodeHighlighter, highlightPrompt, type Styler } from "./highlight.ts";

export { VIEWER_OVERLAY } from "../tool-ref/viewer.ts";

/** Border top/bottom, title row, hint row (as in the /ref panel). */
const CHROME_ROWS = 4;
const RULE_WIDTH = 60;

const HINT = " ↑↓/j k scroll · ←→/h l section · PgUp/PgDn/space page · g/G top/end · q/Esc close";

/** Panel text before wrapping: styled lines and where each prompt section starts. */
export interface PanelContent {
  lines: string[];
  sections: Array<{ title: string; line: number }>;
}

/**
 * The prompt's parts as shown: pi's recorded sections (marked when they are block B), or
 * before the first prompt the whole base prompt; without sections, split at block B.
 */
function promptParts(v: ContextView): Array<{ title: string; text: string }> {
  if (v.built && v.sections?.length) {
    return v.sections.map((s) => ({ title: inBlockB(v, s) ? `${s.name} · block B (project)` : s.name, text: s.text }));
  }
  const at = blockBStart(v);
  if (at < 0) return [{ title: v.built ? "system prompt (last sent)" : "system prompt (base)", text: v.systemPrompt }];
  return [
    { title: "system prompt (last sent) · block A (shared)", text: v.systemPrompt.slice(0, at) },
    { title: "block B (project)", text: v.systemPrompt.slice(at + SEPARATOR.length) },
  ];
}

/**
 * The /context panel's content: the setup (scenario, project, tools, size; labels muted), the
 * note before the first prompt, then each prompt section under a rule with its name and size,
 * syntax highlighted.
 */
export function contextPanel(v: ContextView, s: Styler, code: CodeHighlighter): PanelContent {
  const lines = contextHeader(v).map((l) => {
    const colon = l.indexOf(":");
    return colon < 0 ? l : s.fg("muted", l.slice(0, colon + 1)) + l.slice(colon + 1);
  });
  if (!v.built) lines.push(...NOT_BUILT_NOTE.map((l) => s.fg("warning", l)));
  const sections: PanelContent["sections"] = [];
  for (const part of promptParts(v)) {
    const size = ` ~${tokens(part.text)} tokens `;
    const fill = "─".repeat(Math.max(4, RULE_WIDTH - part.title.length - size.length));
    lines.push("");
    sections.push({ title: part.title, line: lines.length });
    lines.push(s.fg("border", "──── ") + s.fg("accent", part.title) + s.fg("dim", size) + s.fg("border", fill));
    lines.push(...highlightPrompt(part.text, s, code));
  }
  return { lines, sections };
}

/**
 * Floating, scrollable panel for `/context` (`ctx.ui.custom(..., { overlay: true })`), sized
 * and keyed like the /ref panel. ←/→ (h/l) jump to the previous/next prompt section; the title
 * row shows the section at the top of the view. Closes through `done()`.
 */
export class ContextViewer implements Component {
  private top = 0;
  private content: PanelContent | undefined;
  private cache: { width: number; lines: string[]; starts: number[] } | undefined;
  private innerWidth = 80;

  private readonly tui: TUI;
  private readonly theme: Styler;
  private readonly view: ContextView;
  private readonly done: () => void;
  private readonly code: CodeHighlighter;

  constructor(tui: TUI, theme: Styler, view: ContextView, done: () => void, code: CodeHighlighter = highlightCode) {
    this.tui = tui;
    this.theme = theme;
    this.view = view;
    this.done = done;
    this.code = code;
  }

  /** Wrapped lines and each section's first wrapped line, cached by width. */
  private layout(width: number) {
    if (this.cache?.width !== width) {
      this.content ??= contextPanel(this.view, this.theme, this.code);
      const lines: string[] = [];
      const firstRow: number[] = [];
      for (const l of this.content.lines) {
        firstRow.push(lines.length);
        lines.push(...(l === "" ? [""] : wrapTextWithAnsi(l, width)));
      }
      this.cache = { width, lines, starts: this.content.sections.map((s) => firstRow[s.line]!) };
    }
    return this.cache;
  }

  private viewHeight(): number {
    return Math.max(3, Math.floor(this.tui.terminal.rows * VIEWER_HEIGHT) - CHROME_ROWS);
  }

  private maxTop(): number {
    return Math.max(0, this.layout(this.innerWidth).lines.length - this.viewHeight());
  }

  /** Index of the section shown at the top of the view (-1 above the first one). */
  private sectionAt(top: number): number {
    const { starts } = this.layout(this.innerWidth);
    let i = -1;
    while (i + 1 < starts.length && starts[i + 1]! <= top) i++;
    return i;
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2);
    this.innerWidth = inner;
    const { lines } = this.layout(inner);
    const height = this.viewHeight();
    const top = (this.top = Math.min(this.top, this.maxTop()));
    const end = Math.min(lines.length, top + height);

    const th = this.theme;
    const border = (t: string) => th.fg("border", t);
    const row = (t: string) => border("│") + truncateToWidth(t, inner, "", true) + border("│");
    const current = this.sectionAt(top);
    const where = current < 0 ? "" : ` · ${this.content!.sections[current]!.title} (${current + 1}/${this.content!.sections.length})`;
    const position = lines.length > height ? `  ${top + 1}-${end}/${lines.length}` : "";

    const out = [border(`╭${"─".repeat(inner)}╮`), row(th.fg("accent", ` /context${where}`) + th.fg("dim", position))];
    for (let i = top; i < end; i++) out.push(row(lines[i]!));
    for (let i = end - top; i < height; i++) out.push(row(""));
    out.push(row(th.fg("dim", HINT)), border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done();
      return;
    }
    const page = this.viewHeight();
    const { starts } = this.layout(this.innerWidth);
    let top = this.top;
    if (matchesKey(data, "up") || data === "k") top--;
    else if (matchesKey(data, "down") || data === "j") top++;
    else if (matchesKey(data, "pageUp") || data === "b") top -= page;
    else if (matchesKey(data, "pageDown") || data === " ") top += page;
    else if (matchesKey(data, "home") || data === "g") top = 0;
    else if (matchesKey(data, "end") || data === "G") top = this.maxTop();
    else if (matchesKey(data, "right") || data === "l") top = starts.find((s) => s > top) ?? top;
    else if (matchesKey(data, "left") || data === "h") {
      // To the start of the current section, or the previous one when already there.
      top = [...starts].reverse().find((s) => s < top) ?? 0;
    } else return;

    top = Math.max(0, Math.min(top, this.maxTop()));
    if (top === this.top) return;
    this.top = top;
    this.tui.requestRender();
  }

  invalidate(): void {
    // Also after a theme change: the highlighting depends on the theme.
    this.content = undefined;
    this.cache = undefined;
  }
}
