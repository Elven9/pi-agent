import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY } from "../shared/protocol.ts";
import { latestSessionVersion, PI_AGENT_VERSION, type SessionVersionEntry } from "../shared/session-version.ts";

/**
 * Session version extension (src/shared/session-version.ts), loaded by personal pi (package
 * manifest) and the runner (`-e dist/session-version.js`). At every session start (new, resumed,
 * forked, reloaded) it appends a `pi-agent.session-version` entry with the running pi-agent
 * release, unless the file's latest one already has it.
 */
export default createSessionVersion();

/** The extension factory; `version` is for tests. */
export function createSessionVersion(version: string = PI_AGENT_VERSION) {
  return (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, ctx) => {
      if (latestSessionVersion(ctx.sessionManager.getEntries()) === version) return;
      pi.appendEntry<SessionVersionEntry>(ENTRY.sessionVersion, { version });
    });
  };
}
