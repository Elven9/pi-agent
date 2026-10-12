import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionUpload } from "./index.ts";
import { METRICS_FLUSH_CHANNEL } from "../shared/protocol.ts";
import { server } from "./test-server.ts";

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
async function fakePi(settings: object | string | undefined, sessionFile: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-upload-ext-"));
  const settingsPath = join(dir, "session-upload.json");
  if (settings !== undefined) await writeFile(settingsPath, typeof settings === "string" ? settings : JSON.stringify(settings));
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const notices: Array<[string, string]> = [];
  const flushes: unknown[] = [];
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.set(event, handler),
    registerCommand: (name: string, options: any) => void commands.set(name, options),
    events: { emit: (channel: string) => void (channel === METRICS_FLUSH_CHANNEL && flushes.push(channel)), on: () => () => {} },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string, level: string) => void notices.push([message, level]) },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getHeader: () => ({ type: "session", id: "sess-1" }),
      getSessionId: () => "sess-1",
    },
  };
  createSessionUpload({ settingsPath, env: { CF_ID: "id-1" } })(pi);
  await handlers.get("session_start")!({ type: "session_start" }, ctx);
  return {
    notices,
    flushes,
    shutdown: (reason: string) => handlers.get("session_shutdown")!({ type: "session_shutdown", reason }, ctx),
    command: () => commands.get("upload")!.handler("", ctx),
  };
}

async function sessionFile(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "pi-agent-upload-sess-")), "s.jsonl");
  await writeFile(path, '{"type":"session","id":"sess-1"}\n');
  return path;
}

test("uploads on quit, new, resume and fork, not on reload; flushes metrics first", async () => {
  const srv = await server(200);
  try {
    const pi = await fakePi({ machineId: "mac-1", endpoint: srv.endpoint, headers: { "CF-Access-Client-Id": "$CF_ID" } }, await sessionFile());
    assert.deepEqual(pi.notices, []);
    for (const reason of ["reload", "quit", "new", "resume", "fork"]) await pi.shutdown(reason);
    assert.equal(srv.requests.length, 4);
    assert.equal(pi.flushes.length, 4);
    assert.equal(srv.requests[0].url, "/sessions/mac-1/sess-1");
    assert.equal(srv.requests[0].headers["cf-access-client-id"], "id-1");
  } finally {
    srv.close();
  }
});

test("/upload notifies; without settings or a session file nothing is sent", async () => {
  const srv = await server(200);
  try {
    const pi = await fakePi({ machineId: "mac-1", endpoint: srv.endpoint }, await sessionFile());
    await pi.command();
    assert.match(pi.notices[0][0], /^Uploaded session sess-1 \(1 KB\)$/);

    const noFile = await fakePi({ machineId: "mac-1", endpoint: srv.endpoint }, join(tmpdir(), "pi-agent-none.jsonl"));
    await noFile.command();
    await noFile.shutdown("quit");
    assert.match(noFile.notices[0][0], /^Nothing to upload yet/);

    const off = await fakePi(undefined, await sessionFile());
    await off.command();
    await off.shutdown("quit");
    assert.match(off.notices[0][0], /^Session upload is not configured: no .*session-upload\.json$/);
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test("invalid settings: one warning at start, uploads off", async () => {
  const pi = await fakePi({ machineId: "my mac", endpoint: "https://x.example" }, await sessionFile());
  assert.equal(pi.notices.length, 1);
  assert.match(pi.notices[0][0], /^\[session-upload\] uploads are off: Invalid .*\n\/machineId/);
  assert.equal(pi.notices[0][1], "warning");
});

test("a failed upload on shutdown goes to stderr, /upload shows it", async () => {
  const srv = await server(403);
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => void errors.push(message);
  try {
    const pi = await fakePi({ machineId: "mac-1", endpoint: srv.endpoint }, await sessionFile());
    await pi.shutdown("quit");
    await pi.command();
    assert.match(errors[0], /^\[session-upload\] PUT .* failed: HTTP 403/);
    assert.match(pi.notices[0][0], /^Session upload failed: PUT .* HTTP 403/);
    assert.equal(pi.notices[0][1], "error");
  } finally {
    console.error = original;
    srv.close();
  }
});
