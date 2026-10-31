import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionTags from "./index.ts";
import { ENTRY } from "../shared/protocol.ts";
import { currentTags } from "../shared/tags.ts";

const tagEntry = (tags: string[]) => ({ type: "custom", customType: ENTRY.tags, data: { version: 1, tags, source: "command" } });

/** Minimal ExtensionAPI: entries appended go into the "session file" the next start reads. */
function fakePi(o: { flag?: string; entries?: unknown[]; sessionDir?: string; hasUI?: boolean } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, any>();
  const entries: any[] = [...(o.entries ?? [])];
  const notices: Array<[string, string]> = [];
  const status = new Map<string, string | undefined>();
  let shutdown = false;
  const pi = {
    registerFlag() {},
    getFlag: (name: string) => (name === "tags" ? o.flag : undefined),
    on: (event: string, handler: any) => void handlers.set(event, handler),
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: o.hasUI ?? true,
    shutdown: () => (shutdown = true),
    sessionManager: {
      getEntries: () => [...entries],
      getSessionDir: () => o.sessionDir ?? "/nowhere",
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (message: string, level: string) => void notices.push([message, level]),
      setStatus: (key: string, text: string | undefined) => void status.set(key, text),
    },
  };
  sessionTags(pi);
  return {
    entries,
    notices,
    status,
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
  assert.equal(pi.status.get("tags"), "tags: bug,ui");
});

test("no --tags and no entries: nothing written, no footer", async () => {
  const pi = fakePi();
  await pi.start();
  assert.equal(pi.entries.length, 0);
  assert.equal(pi.status.get("tags"), undefined);
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
    assert.equal(pi.status.get("tags"), "tags: kept");
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
  assert.equal(pi.status.get("tags"), "tags: x,y");
  await pi.tags("x,y");
  assert.equal(pi.notices.at(-1)![0], "Tags unchanged: x, y");
  await pi.tags("bad tag");
  assert.equal(pi.notices.at(-1)![1], "error");
  await pi.tags("--clear");
  assert.deepEqual(currentTags(pi.entries), []);
  assert.equal(pi.status.get("tags"), undefined);
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

test("without a UI (json mode) the footer is left alone", async () => {
  const pi = fakePi({ flag: "a", hasUI: false });
  await pi.start();
  assert.equal(pi.status.size, 0);
  assert.equal(pi.tagEntries().length, 1);
});
