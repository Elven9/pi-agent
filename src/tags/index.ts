import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { decorate, footerSessionStart, setFooterPart } from "../shared/footer.ts";
import { abortSession } from "../shared/abort.ts";
import { ENTRY } from "../shared/protocol.ts";
import {
  currentTags,
  defaultTag,
  parseTags,
  presetTags,
  SKIP_TAG_HISTORY_FLAG,
  TAGS_ENTRY_VERSION,
  TAGS_FLAG,
  type TagsEntry,
} from "../shared/tags.ts";
import { type Section, treeItems } from "./completion.ts";
import { installCommaTrigger } from "./editor.ts";
import { folderTags, historyPath, otherTags, readHistory, recordTags, type TagHistory } from "./history.ts";

/** Status key, outside the TUI (RPC); the TUI shows the tags in the footer's cwd line. */
const STATUS = "tags";
const CLEAR = "--clear";

const same = (a: string[] | undefined, b: string[]) => a !== undefined && a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Session tags (src/shared/tags.ts), loaded by personal pi (package manifest) and the runner
 * (`-e dist/tags.js`, tags from task.json). Records the tags in the session file as
 * `pi-agent.tags` custom entries (never model context); the last entry is the session's tags.
 *
 * - `--tags a,b`: at startup (including `-c`, `--session`, `--fork`), replaces the session's
 *   tags. Not applied again on /new, /resume, /fork or /reload: those keep their session's tags.
 * - Without `--tags`, a session never tagged (at startup or /new) gets the last segment of the
 *   cwd as its tag (`defaultTag`). `/tags --clear` removes it for good (an empty list is a tag
 *   entry, so the default is not applied again).
 * - `/tags` shows them, `/tags a,b` replaces them, `/tags --clear` clears them; completion
 *   shows a small tree: the cwd's default tag, the `tags.presets` setting (a list, or named
 *   groups for display), the tags used recently in this folder (`here`), then those of other
 *   folders (`other`). A comma opens it again.
 * - Tags set with `--tags` or `/tags` are recorded in the tag history (src/tags/history.ts,
 *   `<agent dir>/pi-agent/tag-history.jsonl`): the 10 most recent per folder, without the cwd's
 *   default tag and the presets. `--skip-tag-history` (sandbox runs) records nothing.
 * - The footer shows the current tags left of the cwd, dimmed like the rest of the footer.
 *
 * An entry is only written when the list changes. An invalid `--tags` is an error entry and
 * shuts pi down, like the other extensions' startup errors.
 */
export interface SessionTagsOptions {
  /** The tag history file; default in pi's agent dir (`historyPath`). */
  historyPath?: string;
  now?: () => Date;
}

export default function sessionTags(pi: ExtensionAPI, options: SessionTagsOptions = {}) {
  const now = options.now ?? (() => new Date());
  let tags: string[] | undefined;
  let cwd = "";
  let lastCtx: ExtensionContext | undefined;
  /** Record tag uses in the history file (not with --skip-tag-history). */
  let recordHistory = false;
  /** The history file, loaded on the first completion; reloaded after a write. */
  let known: Promise<TagHistory> | undefined;
  /** The last history write (completion waits for it). */
  let writing: Promise<void> = Promise.resolve();
  /** Offered first by completion: the cwd's default tag, then `tags.presets` (settings.json). */
  let suggested: Section[] = [];

  const file = () => options.historyPath ?? historyPath(getAgentDir());

  pi.registerFlag(TAGS_FLAG, {
    type: "string",
    description: "Comma-separated session tags (a-z 0-9 . _ : / -), recorded in the session file; /tags changes them",
  });
  pi.registerFlag(SKIP_TAG_HISTORY_FLAG, {
    type: "boolean",
    description: "Do not record the session's tags in the tag history (sandbox runs)",
    default: false,
  });

  /** The tags left of the cwd in the footer (src/shared/footer.ts); a status outside the TUI. */
  const showStatus = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS, tags?.length ? `tags: ${tags.join(",")}` : undefined);
      return;
    }
    setFooterPart(pi, ctx, STATUS, "left", tags?.length ? `[${tags.join(",")}]` : undefined);
  };

  /** Records `next` unless it is the current list. Returns whether it wrote an entry. */
  const set = (next: string[], source: TagsEntry["source"]): boolean => {
    if (same(tags, next) || (tags === undefined && next.length === 0)) return false;
    pi.appendEntry<TagsEntry>(ENTRY.tags, { version: TAGS_ENTRY_VERSION, tags: next, source });
    tags = next;
    if (source !== "default") remember(next);
    return true;
  };

  /** Appends the tags to the history, without the ones completion offers anyway (cwd tag, presets). */
  const remember = (next: string[]) => {
    if (!recordHistory) return;
    const offered = new Set(suggested.flatMap((s) => s.tags));
    const used = next.filter((t) => !offered.has(t));
    if (!used.length) return;
    const path = file();
    const dir = cwd;
    const at = now();
    writing = writing
      .then(() => recordTags(path, dir, used, at))
      .catch((err) => {
        if (lastCtx?.hasUI) lastCtx.ui.notify(`[tags] tag history: ${(err as Error).message}`, "warning");
      });
    known = undefined;
  };

  pi.on("session_start", (event, ctx) => {
    // A new session may come with a new UI context: install the footer again.
    footerSessionStart(pi, ctx);
    tags = currentTags(ctx.sessionManager.getEntries());
    cwd = ctx.cwd;
    lastCtx = ctx;
    recordHistory = pi.getFlag(SKIP_TAG_HISTORY_FLAG) !== true;
    known = undefined;
    // Read here, so a settings change applies after /reload.
    const presets = presetTags(pi.getSettings());
    if (presets.invalid.length && ctx.hasUI) {
      ctx.ui.notify(`[tags] tags.presets: ignored invalid tag${presets.invalid.length > 1 ? "s" : ""} ${presets.invalid.join(", ")}`, "warning");
    }
    const cwdTag = defaultTag(ctx.cwd);
    suggested = [
      ...(cwdTag ? [{ name: "cwd", tags: [cwdTag] }] : []),
      ...presets.groups.map((g) => ({ name: g.name ?? "presets", tags: g.tags })),
    ];
    installCommaTrigger(ctx);
    const flag = pi.getFlag(TAGS_FLAG);
    if (event.reason === "startup" && typeof flag === "string") {
      try {
        set(parseTags(flag), "flag");
      } catch (err) {
        const message = `--${TAGS_FLAG}: ${(err as Error).message}`;
        console.error(`[pi-agent] ${message}`);
        abortSession(pi, ctx, message);
        return;
      }
    } else if (tags === undefined && (event.reason === "startup" || event.reason === "new")) {
      const tag = defaultTag(ctx.cwd);
      if (tag) set([tag], "default");
    }
    showStatus(ctx);
  });

  pi.registerCommand("tags", {
    description: `Show the session's tags; "/tags a,b" replaces them, "/tags ${CLEAR}" clears them`,
    getArgumentCompletions: async (prefix) => {
      const cut = prefix.lastIndexOf(",");
      const head = prefix.slice(0, cut + 1);
      const word = prefix.slice(cut + 1).trimStart().toLowerCase();
      if (cut < 0 && word.startsWith("-")) {
        return CLEAR.startsWith(word) ? [{ value: CLEAR, label: CLEAR, description: "Remove every tag" }] : null;
      }
      known ??= writing.then(() => readHistory(file()));
      const history = await known;
      const typed = head.split(",").map((t) => t.trim().toLowerCase());
      const fits = (t: string) => t.startsWith(word) && !typed.includes(t);
      const items = treeItems(
        [...suggested, { name: "here", tags: folderTags(history, cwd) }, { name: "other", tags: otherTags(history, cwd) }],
        head,
        fits,
      );
      return items.length ? items : null;
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

/** The footer's lines with the tags left of the cwd (its first line), dimmed like it. */
export function withTags(lines: string[], tags: string[], theme: Pick<Theme, "fg">, width: number): string[] {
  return decorate(lines, { left: tags.length ? [`[${tags.join(",")}]`] : [], right: [] }, theme, width);
}
