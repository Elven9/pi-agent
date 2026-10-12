import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Settings file name, under `<agent dir>/extensions/`. Global only: a repo can't redirect uploads. */
export const SETTINGS_FILE = "session-upload.json";

/** Request timeout; the upload on shutdown delays pi's exit by at most this. */
export const UPLOAD_TIMEOUT_MS = 15_000;

export const UploadSettingsSchema = Type.Object(
  {
    /** Identifies this machine on the server: `PUT /sessions/<machineId>/<sessionId>`. */
    machineId: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }),
    /** Server base URL, e.g. `https://sessions.example.com`. */
    endpoint: Type.String({ pattern: "^https?://[^\\s]+$" }),
    /**
     * Extra request headers, e.g. Cloudflare Access service-token headers. A value of `$NAME` or
     * `${NAME}` is read from that environment variable at upload time; anything else is literal.
     */
    headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  },
  { additionalProperties: false },
);
export type UploadSettings = Static<typeof UploadSettingsSchema>;

/**
 * Reads the settings file. Undefined if it does not exist (uploads are off); throws with every
 * problem if it is unreadable or invalid.
 */
export async function loadUploadSettings(path: string): Promise<UploadSettings | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid ${path}: ${(err as Error).message}`);
  }
  if (!Value.Check(UploadSettingsSchema, raw)) {
    const errors = Value.Errors(UploadSettingsSchema, raw)
      .filter((e) => e.keyword !== "additionalProperties")
      .map((e) => `${e.instancePath || "/"} ${e.message === "schema is false" ? "is not a known key" : e.message}`);
    throw new Error(`Invalid ${path}:\n${errors.join("\n")}`);
  }
  return raw;
}

/** Header values with `$NAME`/`${NAME}` replaced from `env`. Throws on an unset variable. */
export function resolveHeaders(headers: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const ref = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
    const variable = ref?.[1] ?? ref?.[2];
    if (variable === undefined) {
      resolved[name] = value;
      continue;
    }
    const fromEnv = env[variable];
    if (fromEnv === undefined || fromEnv === "") throw new Error(`header ${name}: environment variable ${variable} is not set`);
    resolved[name] = fromEnv;
  }
  return resolved;
}

export function uploadUrl(settings: UploadSettings, sessionId: string): string {
  const base = settings.endpoint.replace(/\/+$/, "");
  return `${base}/sessions/${encodeURIComponent(settings.machineId)}/${encodeURIComponent(sessionId)}`;
}

/**
 * Uploads the raw session file: `PUT <endpoint>/sessions/<machineId>/<sessionId>`, body = the
 * JSONL file as is. The server replaces what it has. Throws on a non-2xx status, a timeout or a
 * network error. Returns the number of bytes sent.
 */
export async function uploadSession(
  settings: UploadSettings,
  sessionId: string,
  file: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<number> {
  const headers = resolveHeaders(settings.headers, opts.env);
  const body = await readFile(file);
  const url = uploadUrl(settings, sessionId);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/x-ndjson" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw new Error(`PUT ${url} failed: ${(err as Error).message}${cause ? ` (${cause})` : ""}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).trim().slice(0, 200);
    throw new Error(`PUT ${url} failed: HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  await res.body?.cancel().catch(() => {});
  return body.length;
}
