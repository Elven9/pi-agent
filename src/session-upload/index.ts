import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { METRICS_FLUSH_CHANNEL, SESSION_ABORTED_CHANNEL } from "../shared/protocol.ts";
import { type ProgressOptions, seconds, startProgress } from "./progress.ts";
import { loadUploadSettings, SETTINGS_FILE, uploadSession, type UploadSettings } from "./upload.ts";

/** Session changes that leave the current session behind; `reload` keeps it. */
const UPLOAD_ON = new Set(["quit", "new", "resume", "fork"]);

/**
 * Session upload extension (personal pi only: package manifest; sandbox runs start pi with `-ne`,
 * so it never loads there and the orchestrator uploads instead). Uploads the raw session file
 * to `PUT <endpoint>/v1/sessions/<machineId>/<sessionId>`, configured in
 * `<agent dir>/extensions/session-upload.json` (no file: off):
 *
 * - `/upload`: now, with a notification,
 * - on `/quit`, `/new`, `/resume` and `/fork`: the session being left, failures on stderr only.
 *
 * Before each upload it asks the metrics extension to append its latest totals, so the file
 * ends with them. A session with no file yet (nothing said) is skipped.
 *
 * When an extension aborted the session (shared/abort.ts: an error that shuts pi down), nothing
 * is uploaded on the way out: the session did not run. `/upload` still works.
 *
 * While it uploads, a spinner shows the elapsed time (progress.ts): a widget above the editor for
 * /upload, /new, /resume and /fork; on quit (the TUI is already stopped) a line on stderr, then
 * `Session uploaded in 1.2s`.
 */
export default createSessionUpload();

/** The extension factory; `opts` are for tests. */
export function createSessionUpload(opts: { settingsPath?: string; env?: NodeJS.ProcessEnv; progress?: ProgressOptions } = {}) {
  return (pi: ExtensionAPI) => register(pi, opts);
}

function register(pi: ExtensionAPI, opts: { settingsPath?: string; env?: NodeJS.ProcessEnv; progress?: ProgressOptions }) {
  const settingsPath = opts.settingsPath ?? join(getAgentDir(), "extensions", SETTINGS_FILE);
  let settings: UploadSettings | undefined;
  let settingsError: string | undefined;
  /**
   * An extension aborted this session. Not reset at session_start: the abort can come from an
   * earlier extension's session_start, and pi loads a fresh instance for every session.
   */
  let aborted = false;
  pi.events.on(SESSION_ABORTED_CHANNEL, () => void (aborted = true));

  pi.on("session_start", async (_event, ctx) => {
    try {
      settings = await loadUploadSettings(settingsPath);
      settingsError = undefined;
    } catch (err) {
      settings = undefined;
      settingsError = (err as Error).message;
      warn(ctx, `[session-upload] uploads are off: ${settingsError}`);
    }
  });

  /**
   * Appends the latest metrics, then uploads with a spinner (`where`, see progress.ts).
   * Undefined when there is no session file yet.
   */
  const upload = async (
    ctx: ExtensionContext,
    where: "widget" | "terminal",
  ): Promise<{ id: string; bytes: number; ms: number } | undefined> => {
    const file = ctx.sessionManager.getSessionFile();
    if (!settings || !file || !existsSync(file)) return undefined;
    pi.events.emit(METRICS_FLUSH_CHANNEL, undefined);
    const id = ctx.sessionManager.getHeader()?.id ?? ctx.sessionManager.getSessionId();
    const progress = startProgress(ctx, ctx.mode === "tui" ? where : "none", opts.progress);
    try {
      const bytes = await uploadSession(settings, id, file, { env: opts.env });
      return { id, bytes, ms: progress.stop() };
    } catch (err) {
      progress.stop();
      throw err;
    }
  };

  pi.registerCommand("upload", {
    description: "Upload this session file to the session server (session-upload.json)",
    handler: async (_args, ctx) => {
      if (!settings) {
        const reason = settingsError ?? `no ${settingsPath}`;
        ctx.ui.notify(`Session upload is not configured: ${reason}`, "warning");
        return;
      }
      try {
        const done = await upload(ctx, "widget");
        ctx.ui.notify(
          done
            ? `Uploaded session ${done.id} (${Math.ceil(done.bytes / 1024)} KB) in ${seconds(done.ms)}`
            : "Nothing to upload yet: the session has no file.",
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Session upload failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!UPLOAD_ON.has(event.reason) || aborted) return;
    // Quit stops the TUI before session_shutdown: the spinner goes to the terminal then.
    const quit = event.reason === "quit";
    try {
      const done = await upload(ctx, quit ? "terminal" : "widget");
      const stream = opts.progress?.stream ?? process.stderr;
      if (done && quit && ctx.mode === "tui" && stream.isTTY) stream.write(`Session uploaded in ${seconds(done.ms)}\n`);
    } catch (err) {
      console.error(`[session-upload] ${(err as Error).message}`);
    }
  });
}

function warn(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else console.error(message);
}
