import { type Component, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { VIEWER_HEIGHT } from "../tool-ref/viewer.ts";

export { VIEWER_OVERLAY } from "../tool-ref/viewer.ts";

/**
 * One page of the /agent panel. `live`: rebuilt on every draw and refreshed every second.
 * `headings`: indices of section heading lines (`task:`, `summary:`, …), shown as headers.
 */
export interface AgentPage {
  title: string;
  lines: string[];
  headings?: readonly number[];
  live: boolean;
}

type Styler = { fg(color: any, text: string): string; bold(text: string): string };

/** A section heading row: `task:` → bold accent (pink) `Task`, then a dim rule to the panel's width. */
export function headingRow(line: string, width: number, th: Styler): string {
  const label = line.replace(/:$/, "");
  const text = label.charAt(0).toUpperCase() + label.slice(1);
  const rest = Math.max(0, width - visibleWidth(text) - 1);
  return truncateToWidth(th.bold(th.fg("accent", text)) + (rest ? " " + th.fg("dim", "─".repeat(rest)) : ""), width);
}

/** Border top/bottom, title row, hint row (as the /ref panel). */
const CHROME_ROWS = 4;
const HINT = " ↑↓/j k scroll · PgUp/PgDn/space page · g/G top/end · q/Esc close";
const REFRESH_MS = 1000;

/**
 * Floating `/agent` panel (`ctx.ui.custom(..., { overlay: true })`), sized and keyed like the
 * /ref panel: one subagent per page, ←/→ (h/l) between them, shift+←/→ first/last. A live
 * child's page is rebuilt on every draw (progress, running time) and refreshed every second;
 * `x` on it asks `kill aN? y/n` in the hint row. Closes through `done()`.
 */
export class AgentViewer implements Component {
  private page: number;
  private readonly tops = new Map<number, number>();
  private readonly built = new Map<number, AgentPage>();
  private innerWidth = 80;
  private confirming = false;
  private status: { text: string; error: boolean } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly tui: TUI;
  private readonly theme: Styler;
  private readonly title: string;
  private readonly ids: readonly number[];
  private readonly build: (id: number) => AgentPage;
  private readonly kill: (id: number) => Promise<string>;
  private readonly done: () => void;

  constructor(
    tui: TUI,
    theme: Styler,
    title: string,
    ids: readonly number[],
    build: (id: number) => AgentPage,
    kill: (id: number) => Promise<string>,
    done: () => void,
    options: { start?: number } = {},
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.ids = ids;
    this.build = build;
    this.kill = kill;
    this.done = done;
    this.page = Math.max(0, Math.min(ids.length - 1, options.start ?? 0));
    this.timer = setInterval(() => {
      if (this.current.live) this.tui.requestRender();
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  private get current(): AgentPage {
    let page = this.built.get(this.page);
    if (!page || page.live) {
      page = this.build(this.ids[this.page]!);
      this.built.set(this.page, page);
    }
    return page;
  }

  private viewHeight(): number {
    return Math.max(3, Math.floor(this.tui.terminal.rows * VIEWER_HEIGHT) - CHROME_ROWS);
  }

  private wrapped(width: number): string[] {
    const page = this.current;
    const headings = new Set(page.headings ?? []);
    return page.lines.flatMap((l, i) => (headings.has(i) ? [headingRow(l, width, this.theme)] : l === "" ? [""] : wrapTextWithAnsi(l, width)));
  }

  private maxTop(): number {
    return Math.max(0, this.wrapped(this.innerWidth).length - this.viewHeight());
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2);
    this.innerWidth = inner;
    const page = this.current;
    const lines = this.wrapped(inner);
    const height = this.viewHeight();
    const top = Math.min(this.tops.get(this.page) ?? 0, Math.max(0, lines.length - height));
    this.tops.set(this.page, top);
    const end = Math.min(lines.length, top + height);

    const th = this.theme;
    const border = (s: string) => th.fg("border", s);
    const row = (s: string) => border("│") + truncateToWidth(s, inner, "", true) + border("│");
    const many = this.ids.length > 1;
    const pager = many ? ` · ‹ ${this.page + 1}/${this.ids.length} ›` : "";
    const position = lines.length > height ? `  ${top + 1}-${end}/${lines.length}` : "";
    const out = [border(`╭${"─".repeat(inner)}╮`), row(th.fg("accent", ` ${this.title}${pager} · ${page.title}`) + th.fg("dim", position))];
    for (let i = top; i < end; i++) out.push(row(lines[i]!));
    for (let i = end - top; i < height; i++) out.push(row(""));
    let footer: string;
    if (this.confirming) footer = th.fg("warning", ` kill a${this.ids[this.page]}? y/n`);
    else if (this.status) footer = th.fg(this.status.error ? "error" : "success", ` ${this.status.text}`);
    // The kill key first: the hint is cut at the panel width.
    else footer = th.fg("dim", (page.live ? " x kill ·" : "") + (many ? " ←→/h l agent · ⇧←→ first/last ·" : "") + HINT);
    out.push(row(footer), border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    if (this.confirming) {
      this.confirming = false;
      if (data === "y" || data === "Y") {
        const id = this.ids[this.page]!;
        this.status = { text: `killing a${id}…`, error: false };
        this.kill(id).then(
          (text) => this.setStatus(text, false),
          (err: Error) => this.setStatus(err.message, true),
        );
      }
      this.tui.requestRender();
      return;
    }
    if (this.status) this.status = undefined;
    if (matchesKey(data, "escape") || data === "q") {
      this.dispose();
      this.done();
      return;
    }
    if (data === "x" && this.current.live) {
      this.confirming = true;
      this.tui.requestRender();
      return;
    }
    const last = this.ids.length - 1;
    const target = matchesKey(data, "shift+left")
      ? 0
      : matchesKey(data, "shift+right")
        ? last
        : matchesKey(data, "left") || data === "h"
          ? this.page - 1
          : matchesKey(data, "right") || data === "l"
            ? this.page + 1
            : undefined;
    if (target !== undefined) {
      const next = Math.max(0, Math.min(last, target));
      if (next !== this.page) {
        this.page = next;
        this.tui.requestRender();
      }
      return;
    }
    const pageRows = this.viewHeight();
    let top = this.tops.get(this.page) ?? 0;
    if (matchesKey(data, "up") || data === "k") top--;
    else if (matchesKey(data, "down") || data === "j") top++;
    else if (matchesKey(data, "pageUp") || data === "b") top -= pageRows;
    else if (matchesKey(data, "pageDown") || data === " ") top += pageRows;
    else if (matchesKey(data, "home") || data === "g") top = 0;
    else if (matchesKey(data, "end") || data === "G") top = this.maxTop();
    else return;
    top = Math.max(0, Math.min(top, this.maxTop()));
    this.tops.set(this.page, top);
    this.tui.requestRender();
  }

  private setStatus(text: string, error: boolean): void {
    this.status = { text, error };
    this.built.delete(this.page);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.built.clear();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
