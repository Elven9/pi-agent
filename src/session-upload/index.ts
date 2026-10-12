import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { METRICS_FLUSH_CHANNEL } from "../shared/protocol.ts";
import { loadUploadSettings, SETTINGS_FILE, uploadSession, type UploadSettings } from "./upload.ts";

/** Session changes that leave the current session behind; `reload` keeps it. */
const UPLOAD_ON = new Set(["quit", "new", "resume", "fork"]);

/**
 * Session upload extension (personal pi only: package manifest; sandbox runs start pi with `-ne`,
 * so it never loads there and the orchestrator uploads instead). Uploads the raw session file
 * to `PUT <endpoint>/sessions/<machineId>/<sessionId>`, configured in
 * `<agent dir>/extensions/session-upload.json` (no file: off):
 *
 * - `/upload`: now, with a notification,
 * - on `/quit`, `/new`, `/resume` and `/fork`: the session being left, failures on stderr only.
 *
 * Before each upload it asks the metrics extension to append its latest totals, so the file
 * ends with them. A session with no file yet (nothing said) is skipped.
 */
export default createSessionUpload();

/** The extension factory; `opts` are for tests. */
export function createSessionUpload(opts: { settingsPath?: string; env?: NodeJS.ProcessEnv } = {}) {
  return (pi: ExtensionAPI) => register(pi, opts);
}

function register(pi: ExtensionAPI, opts: { settingsPath?: string; env?: NodeJS.ProcessEnv }) {
  const settingsPath = opts.settingsPath ?? join(getAgentDir(), "extensions", SETTINGS_FILE);
  let settings: UploadSettings | undefined;
  let settingsError: string | undefined;

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

  /** Appends the latest metrics, then uploads. Undefined when there is no session file yet. */
  const upload = async (ctx: ExtensionContext): Promise<{ id: string; bytes: number } | undefined> => {
    const file = ctx.sessionManager.getSessionFile();
    if (!settings || !file || !existsSync(file)) return undefined;
    pi.events.emit(METRICS_FLUSH_CHANNEL, undefined);
    const id = ctx.sessionManager.getHeader()?.id ?? ctx.sessionManager.getSessionId();
    return { id, bytes: await uploadSession(settings, id, file, { env: opts.env }) };
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
        const done = await upload(ctx);
        ctx.ui.notify(
          done ? `Uploaded session ${done.id} (${Math.ceil(done.bytes / 1024)} KB)` : "Nothing to upload yet: the session has no file.",
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Session upload failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!UPLOAD_ON.has(event.reason)) return;
    try {
      await upload(ctx);
    } catch (err) {
      console.error(`[session-upload] ${(err as Error).message}`);
    }
  });
}

function warn(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else console.error(message);
}
