import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionVersion } from "./index.ts";
import { ENTRY } from "../shared/protocol.ts";
import { entrySessionVersion, latestSessionVersion, PI_AGENT_VERSION } from "../shared/session-version.ts";

const versionEntry = (version: unknown) => ({ type: "custom", customType: ENTRY.sessionVersion, data: { version } });

/** Minimal ExtensionAPI: entries appended go into the "session file" the next start reads. */
function fakePi(version: string, entries: unknown[] = []) {
  let onStart: ((event: unknown, ctx: unknown) => void) | undefined;
  const pi = {
    on: (event: string, handler: any) => void (event === "session_start" && (onStart = handler)),
    appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  createSessionVersion(version)(pi);
  const ctx = { sessionManager: { getEntries: () => [...entries] } };
  return { entries, start: () => onStart!({ type: "session_start", reason: "startup" }, ctx) };
}

test("PI_AGENT_VERSION is package.json's version when run from source", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(PI_AGENT_VERSION, pkg.version);
});

test("records the version once per release: new session, restart, newer release", () => {
  const s = fakePi("0.11.0");
  s.start();
  assert.deepEqual(s.entries, [versionEntry("0.11.0")]);
  s.start();
  assert.equal(s.entries.length, 1);

  const newer = fakePi("0.12.0", s.entries);
  newer.start();
  assert.deepEqual(newer.entries, [versionEntry("0.11.0"), versionEntry("0.12.0")]);
  assert.equal(latestSessionVersion(newer.entries), "0.12.0");
});

test("a session from before session versions gets an entry", () => {
  const s = fakePi("0.11.0", [{ type: "message", id: "a", parentId: null }]);
  s.start();
  assert.deepEqual(s.entries.at(-1), versionEntry("0.11.0"));
});

test("readers ignore other and malformed entries", () => {
  assert.equal(entrySessionVersion(versionEntry("0.11.0")), "0.11.0");
  assert.equal(entrySessionVersion(versionEntry(3)), undefined);
  assert.equal(entrySessionVersion(versionEntry("")), undefined);
  assert.equal(entrySessionVersion({ type: "custom", customType: ENTRY.tags, data: { version: "1" } }), undefined);
  assert.equal(entrySessionVersion(null), undefined);
  assert.equal(latestSessionVersion([{ type: "session", version: 3 }]), undefined);
});
