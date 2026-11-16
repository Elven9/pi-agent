import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { type ChildExit, RpcChild, type RpcRecord } from "./rpc.ts";

const FAKE = fileURLToPath(new URL("../../testdata/fake-pi-rpc.mjs", import.meta.url));

function fake(spec: object) {
  const child = new RpcChild(process.execPath, [FAKE], { cwd: process.cwd(), env: { ...process.env, FAKE_RPC: JSON.stringify(spec) } });
  const events: RpcRecord[] = [];
  child.onEvent((e) => events.push(e));
  const exit = new Promise<ChildExit>((resolve) => child.onExit(resolve));
  const settled = new Promise<void>((resolve) => child.onEvent((e) => e.type === "agent_settled" && resolve()));
  return { child, events, exit, settled };
}

test("requests are answered by ID; events reach listeners; LF-only framing keeps U+2028 inside a record", async () => {
  const unicode = "a\u2028b\u2029c";
  const { child, events, settled } = fake({ steps: [{ tool: "bash", args: { command: "ls" } }], result: { status: "ok", summary: "done" }, unicode });
  const [state, prompt] = await Promise.all([child.request("get_state"), child.request("prompt", { message: "go" })]);
  assert.deepEqual(state, { sessionFile: "/tmp/child.jsonl" });
  assert.deepEqual(prompt, { disposition: "started" });
  await settled;
  assert.equal(events.find((e) => e.type === "message_update")?.text, unicode);
  assert.deepEqual(
    events.map((e) => `${e.type}${e.toolName ? `:${e.toolName}` : ""}`),
    ["agent_start", "message_update", "tool_execution_start:bash", "tool_execution_end:bash", "tool_execution_start:send_to_leader", "tool_execution_end:send_to_leader", "agent_end", "agent_settled"],
  );
  await child.stop(1000);
});

test("stop: stdin EOF + SIGTERM ends an orderly child", async () => {
  const { child, exit } = fake({ hang: true });
  await child.request("prompt", { message: "go" });
  const t0 = Date.now();
  await child.stop(5000);
  const e = await exit;
  assert.ok(e.code === 0 || e.signal === "SIGTERM", JSON.stringify(e));
  assert.ok(Date.now() - t0 < 2000);
});

test("stop: SIGKILL after the grace period for a child that ignores SIGTERM and EOF", async () => {
  const { child, exit } = fake({ hang: true, ignoreTerm: true });
  await child.request("prompt", { message: "go" });
  const t0 = Date.now();
  await child.stop(300);
  assert.equal((await exit).signal, "SIGKILL");
  assert.ok(Date.now() - t0 >= 250);
});

test("a crash rejects pending requests and reports the exit with stderr", async () => {
  const { child, exit } = fake({ crash: 3 });
  await child.request("prompt", { message: "go" }).catch(() => {});
  const e = await exit;
  assert.equal(e.code, 3);
  assert.match(child.stderrTail(), /fake crash/);
  await assert.rejects(child.request("get_state"), /exited with code 3/);
});

test("a command that cannot start is an exit with an error", async () => {
  const child = new RpcChild("/no/such/pi", [], { cwd: process.cwd(), env: process.env });
  const e = await new Promise<ChildExit>((resolve) => child.onExit(resolve));
  assert.match(e.error ?? "", /ENOENT/);
});
