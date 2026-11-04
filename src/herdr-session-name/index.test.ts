import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { herdrSessionName } from "./index.ts";

const HERDR = { HERDR_ENV: "1", HERDR_PANE_ID: "wD:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
const OK: ExecResult = { stdout: "{}", stderr: "", code: 0, killed: false, truncated: false };

/** Minimal ExtensionAPI: records handlers and herdr calls (args after "herdr"). */
function fakePi(o: { env?: NodeJS.ProcessEnv; name?: string; mode?: string; reply?: (args: string[]) => ExecResult } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const calls: string[][] = [];
  let sessionName = o.name;
  const pi = {
    on: (event: string, handler: any) => void handlers.set(event, handler),
    getSessionName: () => sessionName,
    exec: async (command: string, args: string[]) => {
      assert.equal(command, "herdr");
      calls.push(args);
      return (o.reply ?? (() => OK))(args);
    },
  } as unknown as ExtensionAPI;
  herdrSessionName(pi, o.env ?? HERDR);
  const ctx = { mode: o.mode ?? "tui" };
  /** Lets the background sync finish (fake exec resolves at once). */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    handlers,
    calls,
    /** Short form of each call: "pane:<label>", "agent:<name>", "display:<name>" (null when cleared). */
    summary: () =>
      calls.map((a) =>
        a[0] === "agent"
          ? `agent:${a[3] === "--clear" ? null : a[3]}`
          : a[1] === "rename"
            ? `pane:${a[3] === "--clear" ? null : a[3]}`
            : `display:${a.at(-1) === "--clear-display-agent" ? null : a.at(-1)}`,
      ),
    async start(reason = "startup") {
      await handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
      await flush();
    },
    async rename(name: string | undefined) {
      sessionName = name;
      await handlers.get("session_info_changed")?.({ type: "session_info_changed", name }, ctx);
      await flush();
    },
    async agentStart() {
      await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
      await flush();
    },
    async shutdown(reason = "quit") {
      await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason }, ctx);
    },
  };
}

test("outside herdr: registers nothing", () => {
  for (const env of [{}, { HERDR_ENV: "1" }, { HERDR_PANE_ID: "p" }, { HERDR_ENV: "0", HERDR_PANE_ID: "p" }]) {
    assert.equal(fakePi({ env }).handlers.size, 0);
  }
});

test("outside TUI mode: no herdr calls", async () => {
  const pi = fakePi({ mode: "json", name: "Named" });
  await pi.start();
  await pi.rename("Other");
  await pi.agentStart();
  await pi.shutdown();
  assert.equal(pi.calls.length, 0);
});

test("named session at start: all three set; unnamed: no calls", async () => {
  const named = fakePi({ name: "Refactor auth module" });
  await named.start("resume");
  assert.deepEqual(named.summary(), ["pane:Refactor auth module", "display:Refactor auth module", "agent:refactor-auth-module"]);
  assert.deepEqual(named.calls[0], ["pane", "rename", "wD:p1", "Refactor auth module"]);

  const unnamed = fakePi();
  await unnamed.start("new");
  assert.equal(unnamed.calls.length, 0);
});

test("/name sets and updates all three; clearing the name clears them", async () => {
  const pi = fakePi();
  await pi.start();
  await pi.rename("Refactor the authentication module");
  await pi.rename(undefined);
  assert.deepEqual(pi.summary(), [
    "pane:Refactor the authentica…",
    "display:Refactor the authentication module",
    "agent:refactor-the-authentication-modu", // 32 characters
    "pane:null",
    "agent:null",
    "display:null",
  ]);
});

test("startup before herdr knows pi: agent rename retried on agent_start, only while failing", async () => {
  let detected = false;
  const pi = fakePi({
    name: "Named",
    reply: (args) =>
      args[0] === "agent" && !detected ? { stdout: '{"error":{"code":"agent_not_found"}}', stderr: "", code: 1, killed: false, truncated: false } : OK,
  });
  await pi.start();
  assert.equal(pi.calls.length, 3);
  detected = true;
  await pi.agentStart();
  assert.deepEqual(pi.summary().slice(3), ["pane:Named", "display:Named", "agent:named"]);
  await pi.agentStart();
  assert.equal(pi.calls.length, 6);
});

test("shutdown clears all three, awaited, also for an unnamed session", async () => {
  const pi = fakePi({ name: "Named" });
  await pi.start();
  await pi.shutdown("new");
  assert.deepEqual(pi.summary().slice(3), ["pane:null", "agent:null", "display:null"]);

  const unnamed = fakePi();
  await unnamed.start();
  await unnamed.shutdown("quit");
  assert.deepEqual(unnamed.summary(), ["pane:null", "agent:null", "display:null"]);
});

test("herdr missing: no throw, pi goes on", async () => {
  const pi = fakePi({
    name: "Named",
    reply: () => {
      throw new Error("spawn herdr ENOENT");
    },
  });
  await pi.start();
  await pi.rename("Other");
  await pi.agentStart();
  await pi.shutdown();
  assert.ok(pi.calls.length > 0);
});
