import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { CALL_TIMEOUT_MS, createHerdr, errorCode, METADATA_SOURCE, type Exec } from "./herdr.ts";

const ok: ExecResult = { stdout: '{"id":"cli:pane:rename","result":{}}\n', stderr: "", code: 0, killed: false };
const fail = (code: string): ExecResult => ({
  stdout: JSON.stringify({ error: { code, message: "x" }, id: "cli:agent:rename" }) + "\n",
  stderr: "",
  code: 1,
  killed: false,
});

function recorder(reply: (args: string[]) => ExecResult | Promise<ExecResult> = () => ok) {
  const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, timeout: options?.timeout });
    return reply(args);
  };
  return { exec, calls };
}

test("pane rename: label as one argument, or --clear", async () => {
  const r = recorder();
  const herdr = createHerdr(r.exec, "wD:p1");
  assert.deepEqual(await herdr.renamePane("--x label"), { ok: true });
  await herdr.renamePane();
  assert.deepEqual(
    r.calls.map((c) => [c.command, ...c.args]),
    [
      ["herdr", "pane", "rename", "wD:p1", "--x label"],
      ["herdr", "pane", "rename", "wD:p1", "--clear"],
    ],
  );
  assert.equal(r.calls[0]!.timeout, CALL_TIMEOUT_MS);
});

test("agent rename: name or --clear", async () => {
  const r = recorder();
  const herdr = createHerdr(r.exec, "wD:p1");
  await herdr.renameAgent("refactor-auth");
  await herdr.renameAgent();
  assert.deepEqual(
    r.calls.map((c) => c.args),
    [
      ["agent", "rename", "wD:p1", "refactor-auth"],
      ["agent", "rename", "wD:p1", "--clear"],
    ],
  );
});

test("report-metadata: our source, pi only, seq, display name or clear", async () => {
  const r = recorder();
  const herdr = createHerdr(r.exec, "wD:p1");
  await herdr.displayAgent("-Refactor auth", 7);
  await herdr.displayAgent(undefined, 8);
  const base = ["pane", "report-metadata", "wD:p1", "--source", METADATA_SOURCE, "--agent", "pi", "--seq"];
  assert.deepEqual(
    r.calls.map((c) => c.args),
    [
      [...base, "7", "--display-agent", "-Refactor auth"],
      [...base, "8", "--clear-display-agent"],
    ],
  );
});

test("failures carry herdr's error code and never throw", async () => {
  const taken = createHerdr(async () => fail("agent_name_taken"), "p");
  assert.deepEqual(await taken.renameAgent("x"), { ok: false, code: "agent_name_taken" });

  const usage = createHerdr(async () => ({ stdout: "", stderr: "unknown option: --x\n", code: 2, killed: false }), "p");
  assert.deepEqual(await usage.renamePane("x"), { ok: false });

  const killed = createHerdr(async () => ({ ...ok, code: 0, killed: true }), "p");
  assert.deepEqual(await killed.renamePane("x"), { ok: false });

  const missing = createHerdr(async () => {
    throw new Error("spawn herdr ENOENT");
  }, "p");
  assert.deepEqual(await missing.displayAgent("x", 1), { ok: false });
});

test("errorCode: reads herdr's JSON from stdout or stderr, ignores other text", () => {
  assert.equal(errorCode(fail("pane_not_found")), "pane_not_found");
  assert.equal(errorCode({ stdout: "", stderr: 'noise\n{"error":{"code":"agent_not_found"}}' }), "agent_not_found");
  assert.equal(errorCode({ stdout: "{not json", stderr: "" }), undefined);
  assert.equal(errorCode({ stdout: '{"result":{}}', stderr: "" }), undefined);
});
