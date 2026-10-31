import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as themeModule from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import sessionTags, { withTags } from "./index.ts";
import { ENTRY } from "../shared/protocol.ts";
import { currentTags } from "../shared/tags.ts";

/** The theme pi passes to footer factories (its global one, after initTheme). */
const realTheme = () => themeModule.theme;

const tagEntry = (tags: string[]) => ({ type: "custom", customType: ENTRY.tags, data: { version: 1, tags, source: "command" } });

/** Minimal ExtensionAPI: entries appended go into the "session file" the next start reads. */
function fakePi(o: { flag?: string; entries?: unknown[]; sessionDir?: string; mode?: string } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, any>();
  const entries: any[] = [...(o.entries ?? [])];
  const notices: Array<[string, string]> = [];
  const status = new Map<string, string | undefined>();
  let footer: any;
  let footerCalls = 0;
  let shutdown = false;
  const pi = {
    registerFlag() {},
    getFlag: (name: string) => (name === "tags" ? o.flag : undefined),
    on: (event: string, handler: any) => void handlers.set(event, handler),
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data }),
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: o.mode ?? "tui",
    hasUI: (o.mode ?? "tui") !== "json",
    cwd: "/w",
    model: undefined,
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => undefined,
    shutdown: () => (shutdown = true),
    sessionManager: {
      getEntries: () => [...entries],
      getSessionDir: () => o.sessionDir ?? "/nowhere",
      getSessionFile: () => undefined,
      getCwd: () => "/w",
      getSessionId: () => "s",
      getLeafId: () => null,
      getEntryCount: () => entries.length,
      getSessionName: () => undefined,
    },
    ui: {
      notify: (message: string, level: string) => void notices.push([message, level]),
      setStatus: (key: string, text: string | undefined) => void status.set(key, text),
      setFooter: (factory: any) => {
        footerCalls++;
        footer = factory;
      },
    },
  };
  sessionTags(pi);
  return {
    entries,
    notices,
    status,
    get footer() {
      return footer;
    },
    get footerCalls() {
      return footerCalls;
    },
    /** The footer's lines, rendered with plain-text theme colors. */
    renderFooter(width = 80, theme: unknown = realTheme()) {
      const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
      return footer({ requestRender() {} }, theme, footerData).render(width) as string[];
    },
    get shutdown() {
      return shutdown;
    },
    tagEntries: () => entries.filter((e) => e.customType === ENTRY.tags),
    start: (reason = "startup") => handlers.get("session_start")!({ type: "session_start", reason }, ctx),
    tags: (args: string) => commands.get("tags").handler(args, ctx),
    complete: (prefix: string) => commands.get("tags").getArgumentCompletions(prefix),
  };
}

test("--tags at startup: one normalized entry, shown in the footer", async () => {
  const pi = fakePi({ flag: "Bug, ui,bug" });
  await pi.start();
  assert.deepEqual(pi.tagEntries().map((e) => e.data), [{ version: 1, tags: ["bug", "ui"], source: "flag" }]);
  assert.equal(pi.status.size, 0);
  assert.ok(pi.footer);
});

test("no --tags and no entries: nothing written, no footer", async () => {
  const pi = fakePi();
  await pi.start();
  assert.equal(pi.entries.length, 0);
  assert.equal(pi.footerCalls, 0);
});

test("resuming with --tags replaces the tags; the same list writes nothing", async () => {
  const pi = fakePi({ flag: "b", entries: [tagEntry(["a"])] });
  await pi.start();
  assert.deepEqual(currentTags(pi.entries), ["b"]);
  const again = fakePi({ flag: "b", entries: pi.entries });
  await again.start();
  assert.equal(again.tagEntries().length, 2);
});

test("--tags is applied only at startup, not on /new, /resume, /fork or /reload", async () => {
  for (const reason of ["new", "resume", "fork", "reload"]) {
    const pi = fakePi({ flag: "x", entries: [tagEntry(["kept"])] });
    await pi.start(reason);
    assert.deepEqual(currentTags(pi.entries), ["kept"], reason);
    assert.ok(pi.footer, reason);
  }
});

test("invalid --tags: error entry and shutdown", async () => {
  const pi = fakePi({ flag: "ok,not ok" });
  const error = console.error;
  console.error = () => {};
  try {
    await pi.start();
  } finally {
    console.error = error;
  }
  assert.equal(pi.shutdown, true);
  assert.match(pi.entries[0].data.message, /^--tags: Invalid tag "not ok"/);
  assert.equal(pi.tagEntries().length, 0);
});

test("/tags shows, overrides and clears; unchanged lists write nothing", async () => {
  const pi = fakePi({ entries: [tagEntry(["a"])] });
  await pi.start();
  await pi.tags("");
  assert.deepEqual(pi.notices.at(-1), ["Tags: a", "info"]);
  await pi.tags("X, y");
  assert.deepEqual(currentTags(pi.entries), ["x", "y"]);
  assert.equal(pi.footerCalls, 1); // installed once; it reads the current tags
  await pi.tags("x,y");
  assert.equal(pi.notices.at(-1)![0], "Tags unchanged: x, y");
  await pi.tags("bad tag");
  assert.equal(pi.notices.at(-1)![1], "error");
  await pi.tags("--clear");
  assert.deepEqual(currentTags(pi.entries), []);
  assert.equal(pi.footer, undefined); // pi's own footer is back
  await pi.tags("--clear");
  assert.equal(pi.notices.at(-1)![0], "No tags to clear");
  assert.equal(pi.tagEntries().length, 3);
  await pi.tags("");
  assert.equal(pi.notices.at(-1)![0], "No tags. Set them with /tags a,b");
});

test("completion: tags used before in this session and the folder's other sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-tags-"));
  await writeFile(join(dir, "old.jsonl"), [JSON.stringify({ type: "session" }), JSON.stringify(tagEntry(["release", "ui"]))].join("\n"));
  await writeFile(join(dir, "notes.txt"), JSON.stringify(tagEntry(["ignored"])));
  const pi = fakePi({ sessionDir: dir, entries: [tagEntry(["bug"]), tagEntry(["regression"])] });
  await pi.start();
  assert.deepEqual((await pi.complete("")).map((i: any) => i.value), ["bug", "regression", "release", "ui"]);
  assert.deepEqual((await pi.complete("re")).map((i: any) => i.value), ["regression", "release"]);
  assert.deepEqual((await pi.complete("bug, R")).map((i: any) => i.value), ["bug,regression", "bug,release"]);
  assert.deepEqual((await pi.complete("ui,")).map((i: any) => i.label), ["bug", "regression", "release"]);
  assert.deepEqual((await pi.complete("--c")).map((i: any) => i.value), ["--clear"]);
  assert.equal(await pi.complete("zzz"), null);
});

test("without a UI (json mode) the footer is left alone; RPC gets a status", async () => {
  const json = fakePi({ flag: "a", mode: "json" });
  await json.start();
  assert.equal(json.status.size, 0);
  assert.equal(json.footerCalls, 0);
  assert.equal(json.tagEntries().length, 1);
  const rpc = fakePi({ flag: "a", mode: "rpc" });
  await rpc.start();
  assert.equal(rpc.status.get("tags"), "tags: a");
  assert.equal(rpc.footerCalls, 0);
});

test("footer: pi's own footer with the tags left of the cwd, dimmed like it", async () => {
  initTheme("dark");
  const pi = fakePi({ flag: "bug,ui" });
  await pi.start();
  const lines = pi.renderFooter();
  // Both segments start with the same color escape (the theme's dim), so the tags look like the cwd.
  const escapes = lines[0]!.match(/\x1b\[[0-9;]*m(?=[^\x1b])/g) ?? [];
  assert.ok(escapes.length >= 2 && escapes.every((e) => e === escapes[0]), JSON.stringify(lines[0]));
  // pi's footer colors the cwd with the theme's dim color, the tags prefix with the same.
  const [first] = lines;
  assert.match(first!, /\[bug,ui\] .*\/w \(main\)/s);
  assert.ok(lines.length >= 2, "pi's stats line is kept");
});

test("withTags: prefixes the first line only, dim, cut to the width", () => {
  const theme = { fg: (_c: string, t: string) => t } as any;
  assert.deepEqual(withTags(["~/w (main)", "stats"], ["a", "b"], theme, 80), ["[a,b] ~/w (main)", "stats"]);
  assert.deepEqual(withTags(["~/w", "s"], [], theme, 80), ["~/w", "s"]);
  assert.equal(withTags(["~/a/long/path"], ["tag"], theme, 10)[0]!.replace(/\x1b\[[0-9;]*m/g, ""), "[tag] ~...");
  const dim = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` } as any;
  assert.equal(withTags(["<dim>~/w</dim>"], ["x"], dim, 80)[0], "<dim>[x] </dim><dim>~/w</dim>");
});
