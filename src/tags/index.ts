import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { FooterComponent, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ENTRY } from "../shared/protocol.ts";
import {
  currentTags,
  parseTags,
  sessionFileTagEntries,
  TAGS_ENTRY_VERSION,
  TAGS_FLAG,
  tagHistory,
  type TagsEntry,
} from "../shared/tags.ts";

/** Status key, outside the TUI (RPC); the TUI shows the tags in the footer's cwd line. */
const STATUS = "tags";
const CLEAR = "--clear";
/** Completion reads the tags of at most this many session files (newest first). */
const MAX_SCANNED_SESSIONS = 200;

const same = (a: string[] | undefined, b: string[]) => a !== undefined && a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Session tags (src/shared/tags.ts), loaded by personal pi (package manifest) and the runner
 * (`-e dist/tags.js`, tags from task.json). Records the tags in the session file as
 * `pi-agent.tags` custom entries (never model context); the last entry is the session's tags.
 *
 * - `--tags a,b`: at startup (including `-c`, `--session`, `--fork`), replaces the session's
 *   tags. Not applied again on /new, /resume, /fork or /reload: those keep their session's tags.
 * - `/tags` shows them, `/tags a,b` replaces them, `/tags --clear` clears them; completion
 *   offers tags used before in this session folder.
 * - The footer shows the current tags left of the cwd, dimmed like the rest of the footer.
 *
 * An entry is only written when the list changes. An invalid `--tags` is an error entry and
 * shuts pi down, like the other extensions' startup errors.
 */
export default function sessionTags(pi: ExtensionAPI) {
  let tags: string[] | undefined;
  let sessionDir: string | undefined;
  let currentFile: string | undefined;
  /** Tags seen in other session files of the folder, loaded on the first completion. */
  let known: Promise<string[]> | undefined;
  /** Tags used in this session (every entry, not just the last). */
  let ownHistory: string[] = [];

  pi.registerFlag(TAGS_FLAG, {
    type: "string",
    description: "Comma-separated session tags (a-z 0-9 . _ : / -), recorded in the session file; /tags changes them",
  });

  /** Whether our footer is installed (only while there are tags). */
  let footer = false;
  const showStatus = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS, tags?.length ? `tags: ${tags.join(",")}` : undefined);
      return;
    }
    if (!tags?.length) {
      if (footer) ctx.ui.setFooter(undefined);
      footer = false;
      return;
    }
    if (footer) return; // it reads `tags` on every render
    footer = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const inner = new FooterComponent(footerSession(pi, ctx) as never, footerData);
      inner.setAutoCompactEnabled((pi.getSettings() as { compaction?: { enabled?: boolean } }).compaction?.enabled !== false);
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        render: (width: number) => withTags(inner.render(width), tags ?? [], theme, width),
        invalidate: () => inner.invalidate(),
        dispose: () => {
          unsubscribe();
          inner.dispose();
        },
      };
    });
  };

  /** Records `next` unless it is the current list. Returns whether it wrote an entry. */
  const set = (next: string[], source: TagsEntry["source"]): boolean => {
    if (same(tags, next) || (tags === undefined && next.length === 0)) return false;
    pi.appendEntry<TagsEntry>(ENTRY.tags, { version: TAGS_ENTRY_VERSION, tags: next, source });
    tags = next;
    for (const t of next) if (!ownHistory.includes(t)) ownHistory.push(t);
    return true;
  };

  pi.on("session_start", (event, ctx) => {
    // A new session may come with a new UI context: install the footer again.
    footer = false;
    const entries = ctx.sessionManager.getEntries();
    tags = currentTags(entries);
    ownHistory = [...new Set(tagHistory(entries).flat())];
    sessionDir = ctx.sessionManager.getSessionDir();
    currentFile = ctx.sessionManager.getSessionFile();
    known = undefined;
    const flag = pi.getFlag(TAGS_FLAG);
    if (event.reason === "startup" && typeof flag === "string") {
      try {
        set(parseTags(flag), "flag");
      } catch (err) {
        const message = `--${TAGS_FLAG}: ${(err as Error).message}`;
        console.error(`[pi-agent] ${message}`);
        pi.appendEntry(ENTRY.error, { message });
        ctx.shutdown();
        return;
      }
    }
    showStatus(ctx);
  });

  /** Tags from the other session files in the folder, newest files first. */
  const scan = async (): Promise<string[]> => {
    if (!sessionDir) return [];
    const dir = sessionDir;
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl"));
    const files = await Promise.all(
      names.map(async (n) => ({ path: join(dir, n), mtime: (await stat(join(dir, n)).catch(() => undefined))?.mtimeMs ?? 0 })),
    );
    const newest = files
      .filter((f) => f.path !== currentFile)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_SCANNED_SESSIONS);
    const texts = await Promise.all(newest.map((f) => readFile(f.path, "utf8").catch(() => "")));
    return [...new Set(texts.flatMap((text) => tagHistory(sessionFileTagEntries(text)).flat()))];
  };

  pi.registerCommand("tags", {
    description: `Show the session's tags; "/tags a,b" replaces them, "/tags ${CLEAR}" clears them`,
    getArgumentCompletions: async (prefix) => {
      const cut = prefix.lastIndexOf(",");
      const head = prefix.slice(0, cut + 1);
      const word = prefix.slice(cut + 1).trimStart().toLowerCase();
      if (cut < 0 && word.startsWith("-")) {
        return CLEAR.startsWith(word) ? [{ value: CLEAR, label: CLEAR, description: "Remove every tag" }] : null;
      }
      known ??= scan();
      const typed = head.split(",").map((t) => t.trim().toLowerCase());
      const candidates = [...new Set([...ownHistory, ...(await known)])]
        .filter((t) => t.startsWith(word) && !typed.includes(t))
        .sort();
      return candidates.length ? candidates.map((t) => ({ value: head + t, label: t })) : null;
    },
    handler: async (args, ctx) => {
      const text = args.trim();
      if (text === "") {
        ctx.ui.notify(tags?.length ? `Tags: ${tags.join(", ")}` : `No tags. Set them with /tags a,b`, "info");
        return;
      }
      let next: string[];
      try {
        next = text === CLEAR ? [] : parseTags(text);
      } catch (err) {
        ctx.ui.notify((err as Error).message, "error");
        return;
      }
      if (!set(next, "command")) {
        ctx.ui.notify(next.length ? `Tags unchanged: ${next.join(", ")}` : "No tags to clear", "info");
        return;
      }
      showStatus(ctx);
      ctx.ui.notify(next.length ? `Tags: ${next.join(", ")}` : "Tags cleared", "info");
    },
  });
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

/** The footer's lines with the tags left of the cwd (its first line), dimmed like it. */
export function withTags(lines: string[], tags: string[], theme: Pick<Theme, "fg">, width: number): string[] {
  if (!tags.length || lines.length === 0) return lines;
  const first = truncateToWidth(theme.fg("dim", `[${tags.join(",")}] `) + lines[0], width, theme.fg("dim", "..."));
  return [first, ...lines.slice(1)];
}
