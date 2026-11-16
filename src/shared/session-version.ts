import { readFileSync } from "node:fs";
import { ENTRY } from "./protocol.ts";

/**
 * pi-agent's session version: the pi-agent release that wrote a session file, recorded as
 * `pi-agent.session-version` custom entries (never model context). pi owns the header's
 * `version` (its file format, migrated on load) and pi-agent can't change it; this is the
 * version of pi-agent's own entries (tags, metrics, worktree, subagent, ...).
 *
 * The session-version extension appends an entry at session start when the file's latest one
 * differs from the running release (or there is none), so a file resumed by a newer release
 * gets a second entry: entries after one were written by that release. A file without any was
 * written before pi-agent recorded its version (releases up to 0.11.0).
 */

/** Replaced with package.json's version by esbuild (build.mjs); undefined when run from source. */
declare const __PI_AGENT_VERSION__: string | undefined;

/** The running pi-agent release (package.json `version`, e.g. "0.11.0"). */
export const PI_AGENT_VERSION: string =
  typeof __PI_AGENT_VERSION__ === "string" ? __PI_AGENT_VERSION__ : sourceVersion();

/** From source (tests, personal pi loading src/): package.json at the repo root. */
function sourceVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error("package.json has no version");
  return pkg.version;
}

export interface SessionVersionEntry {
  /** pi-agent release that wrote this entry and the ones after it, e.g. "0.11.0". */
  version: string;
}

/** Version of a valid `pi-agent.session-version` entry, else undefined (other entries, malformed data). */
export function entrySessionVersion(entry: unknown): string | undefined {
  const e = entry as { type?: unknown; customType?: unknown; data?: { version?: unknown } } | null;
  if (e?.type !== "custom" || e.customType !== ENTRY.sessionVersion) return undefined;
  const version = e.data?.version;
  return typeof version === "string" && version !== "" ? version : undefined;
}

/** The latest recorded pi-agent version in file order; undefined when the file has none. */
export function latestSessionVersion(entries: Iterable<unknown>): string | undefined {
  let version: string | undefined;
  for (const entry of entries) version = entrySessionVersion(entry) ?? version;
  return version;
}
