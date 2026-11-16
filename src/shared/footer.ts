import { FooterComponent, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * pi's footer with pi-agent additions on its first line (cwd, branch, session name): text left
 * of the cwd (worktree, tags) and text right-aligned at the end of the line (subagents), all dimmed like
 * the footer. Several extensions add parts, but pi has one footer: the parts live in a store
 * shared through `globalThis` (extensions are separate bundles), and whichever extension updates
 * a part (re)installs the same footer, which reads the store on every render. Without parts pi's
 * own footer is restored.
 *
 * Interactive UI only; other modes have no footer to change (callers use `setStatus` there).
 */

type Side = "left" | "right";

interface Store {
  parts: Map<string, { side: Side; text: string }>;
  /** The UI the footer is installed in; cleared at every session start. */
  ui?: unknown;
  requestRender?: () => void;
}

const STORE = Symbol.for("pi-agent.footer");

function store(): Store {
  const g = globalThis as { [STORE]?: Store };
  return (g[STORE] ??= { parts: new Map() });
}

/**
 * Call from `session_start`: a new session may come with a new UI, so install again. Parts set
 * earlier in this `session_start` (by an extension loaded before) are installed right away.
 */
export function footerSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const s = store();
  s.ui = undefined;
  if (ctx.mode === "tui" && s.parts.size > 0) install(pi, ctx);
}

/** Sets (`text`) or removes (undefined/empty) one part, and installs or restores the footer as needed. */
export function setFooterPart(pi: ExtensionAPI, ctx: ExtensionContext, key: string, side: Side, text: string | undefined): void {
  if (ctx.mode !== "tui") return;
  const s = store();
  const before = s.parts.get(key);
  if (text) s.parts.set(key, { side, text });
  else s.parts.delete(key);
  if (s.parts.size === 0) {
    if (s.ui !== undefined) ctx.ui.setFooter(undefined);
    s.ui = undefined;
    s.requestRender = undefined;
    return;
  }
  if (s.ui === ctx.ui) {
    if (before?.text !== text) s.requestRender?.();
    return;
  }
  install(pi, ctx);
}

/** Installs the footer in `ctx.ui`; it reads the parts on every render. */
function install(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const s = store();
  s.ui = ctx.ui;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const inner = new FooterComponent(footerSession(pi, ctx) as never, footerData);
    inner.setAutoCompactEnabled((pi.getSettings() as { compaction?: { enabled?: boolean } }).compaction?.enabled !== false);
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    s.requestRender = () => tui.requestRender();
    return {
      render: (width: number) => decorate(inner.render(width), parts(), theme, width),
      invalidate: () => inner.invalidate(),
      dispose: () => {
        unsubscribe();
        inner.dispose();
      },
    };
  });
}

/** The current parts by side, in the order they were added. */
export function parts(): { left: string[]; right: string[] } {
  const all = [...store().parts.values()];
  return { left: all.filter((p) => p.side === "left").map((p) => p.text), right: all.filter((p) => p.side === "right").map((p) => p.text) };
}

/** Narrowest room kept for the cwd before the right part is dropped. */
const MIN_LEFT = 12;

/**
 * The footer's lines with `left` before its first line and `right` at the end of it, dimmed.
 * When the line is too narrow the cwd side is cut first; the right part goes when even the
 * cwd's minimum does not fit.
 */
export function decorate(lines: string[], p: { left: string[]; right: string[] }, theme: Pick<Theme, "fg">, width: number): string[] {
  if (lines.length === 0 || (p.left.length === 0 && p.right.length === 0)) return lines;
  const dim = (t: string) => theme.fg("dim", t);
  const left = p.left.map((t) => dim(`${t} `)).join("") + lines[0];
  const right = p.right.length ? dim(p.right.join("  ")) : "";
  const rightWidth = visibleWidth(right);
  let first: string;
  if (right && width - rightWidth - 1 >= MIN_LEFT) {
    const cut = truncateToWidth(left, width - rightWidth - 1, dim("..."));
    first = cut + " ".repeat(Math.max(1, width - visibleWidth(cut) - rightWidth)) + right;
  } else {
    first = truncateToWidth(left, width, dim("..."));
  }
  return [first, ...lines.slice(1)];
}

/**
 * pi's own footer, fed from the extension context: pi does not hand the built-in footer to
 * `setFooter`, so this builds the same component. What the context can't tell: a virtual
 * model's routed target (not shown), and subscription use, taken as OAuth.
 */
function footerSession(pi: ExtensionAPI, ctx: ExtensionContext) {
  return {
    get state() {
      return { model: ctx.model, thinkingLevel: pi.getThinkingLevel() };
    },
    get model() {
      return ctx.model;
    },
    routedModel: undefined,
    get sessionManager() {
      return ctx.sessionManager;
    },
    getContextUsage: () => ctx.getContextUsage(),
    modelRuntime: { isUsingSubscription: () => (ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false) },
  };
}
