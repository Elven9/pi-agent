import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdr } from "./herdr.ts";
import { createSync } from "./sync.ts";

/**
 * Shows the pi session name in herdr (personal pi only, never the sandbox runner): the pane label
 * (shortened), the agent name in `herdr agent list` (a slug) and the agent name in the sidebar
 * (`pane report-metadata --display-agent`, the full name). Separate from herdr's own pi
 * integration (`~/.pi/agent/extensions/herdr-agent-state.ts`), which herdr overwrites on update.
 *
 * Inside a herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID`) and in TUI mode only, like herdr's own:
 * - session_start: a named session sets the three names.
 * - session_info_changed (`/name`): sets them, or clears them when the name is cleared.
 * - agent_start: applies the name again if a herdr call failed (herdr may not have detected pi yet
 *   at startup), at most 3 times per name.
 * - session_shutdown (quit, /new, /resume, /fork, /reload): clears all three. pi waits for it, so
 *   the clear lands before the next session's runtime sets its names.
 *
 * herdr calls go through its CLI, one at a time, and never throw or block pi.
 */
export function herdrSessionName(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !paneId) return;

  const sync = createSync(
    createHerdr((command, args, options) => pi.exec(command, args, options), paneId),
    paneId,
  );
  let tui = false;

  pi.on("session_start", (_event, ctx) => {
    tui = ctx.mode === "tui";
    if (!tui) return;
    const name = pi.getSessionName();
    if (name) sync.request(name); // unnamed: nothing to do, the previous runtime cleared at shutdown
  });
  pi.on("session_info_changed", (event) => {
    if (tui) sync.request(event.name);
  });
  pi.on("agent_start", () => {
    if (tui) sync.retry();
  });
  pi.on("session_shutdown", async () => {
    if (tui) await sync.shutdown();
  });
}

export default function (pi: ExtensionAPI) {
  herdrSessionName(pi);
}
