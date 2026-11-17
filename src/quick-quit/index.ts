import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The command: `/q!`, like vim's quit without the usual work. */
export const COMMAND = "q!";

/**
 * Quick quit extension (personal pi only: package manifest). `/q!` ends pi at once with
 * `process.exit(0)`, skipping pi's graceful shutdown and so every extension's
 * `session_shutdown` work: no session upload, no final metrics entry, no herdr label cleanup,
 * no orderly subagent stop. `/quit` still does all of that.
 *
 * Nothing written is lost: pi appends session entries synchronously. The terminal is restored by
 * pi-tui's own `exit` handler; after it, the resume command is printed as `/quit` does.
 */
export default createQuickQuit();

/** The extension factory; `exit` is for tests. */
export function createQuickQuit(exit: (code: number) => void = (code) => process.exit(code)) {
  return (pi: ExtensionAPI) => {
    pi.registerCommand(COMMAND, {
      description: "Quit now, skipping every extension's shutdown work (session upload, metrics, ...)",
      handler: async (_args, ctx) => {
        const file = ctx.sessionManager.getSessionFile();
        if (ctx.mode === "tui" && process.stdout.isTTY && file && existsSync(file)) {
          // Registered after pi-tui's restore handler, so it prints below the restored screen.
          process.once("exit", () => process.stdout.write(`To resume this session: pi --session ${file}\n`));
        }
        exit(0);
      },
    });
  };
}
