import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENTRY, SESSION_ABORTED_CHANNEL } from "./protocol.ts";

/**
 * Ends pi because an extension cannot run (invalid flag or setting, setup mismatch, ...): a
 * `pi-agent.error` entry, a SESSION_ABORTED_CHANNEL announcement (the session-upload extension
 * then skips its upload on the way out), then `ctx.shutdown()`. Telling the user (stderr, or
 * stderr once the TUI stopped) stays with the caller.
 */
export function abortSession(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "shutdown">, message: string): void {
  pi.appendEntry(ENTRY.error, { message });
  pi.events.emit(SESSION_ABORTED_CHANNEL, { message });
  ctx.shutdown();
}
