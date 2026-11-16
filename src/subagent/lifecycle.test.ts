import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SubagentManager } from "./manager.ts";
import type { ResultDetails } from "./protocol.ts";
import { RpcChild } from "./rpc.ts";
// @ts-expect-error plain JS test helper
import { childPiArgs } from "../../testdata/subagent-pi.mjs";

/**
 * Process tests with real `pi --mode rpc` children (the pinned pi, a scripted faux model): the
 * result path through the real event stream, and that no child outlives its leader.
 */

const LEADER = fileURLToPath(new URL("../../testdata/subagent-leader.mjs", import.meta.url));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms: number) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/** Starts the stand-in leader in its own process group; resolves with its and its children's PIDs. */
function startLeader(n: number) {
  const proc = spawn(process.execPath, [LEADER, String(n)], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise<{ leader: number; children: number[] }>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out));
    });
    proc.on("exit", (code) => reject(new Error(`leader exited early (${code})`)));
  });
}

test("a real child: progress from its tool calls, its send_to_leader result, then it is reaped", { timeout: 30_000 }, async () => {
  const results: ResultDetails[] = [];
  const lines: string[] = [];
  let child: RpcChild | undefined;
  const manager = new SubagentManager({
    startChild: () => {
      const { args, options } = childPiArgs(
        [{ tool: "slow_tool", args: { ms: 50 } }, { tool: "send_to_leader", args: { status: "ok", summary: "real child ok" } }],
        { subagent: true },
      );
      child = new RpcChild(process.execPath, args, options);
      return child;
    },
    prompt: () => "go",
    onResult: (r) => results.push(r),
    onChange: () => {
      const v = manager.views()[0];
      if (v && lines.at(-1) !== v.line) lines.push(v.line);
    },
    now: () => Date.now(),
    graceMs: 2000,
  });
  manager.spawn({ id: 1, scenario: "demo", kind: "task", task: "t", startedAt: Date.now(), taskMessageId: "m1" });
  assert.ok(await until(() => results.length > 0, 20_000), `no result; stderr: ${child?.stderrTail()}`);
  assert.equal(results[0]!.envelope.body.status, "ok");
  assert.equal(results[0]!.envelope.body.summary, "real child ok");
  assert.ok(lines.some((l) => l.startsWith("slow_tool")), lines.join(" | "));
  assert.ok(await until(() => manager.size === 0, 5000), "reaped");
  assert.equal(alive(child!.pid!), false);
});

test("leader killed with SIGKILL: its children shut down by themselves (stdin EOF)", { timeout: 30_000 }, async () => {
  const { leader, children } = await startLeader(2);
  assert.ok(children.every(alive));
  process.kill(leader, "SIGKILL");
  const gone = await until(() => children.every((p) => !alive(p)), 5000);
  for (const p of children) if (alive(p)) process.kill(p, "SIGKILL");
  assert.ok(gone, "children outlived the leader");
});

test("SIGHUP to the leader's process group (terminal closed): leader and children all end", { timeout: 30_000 }, async () => {
  const { leader, children } = await startLeader(2);
  process.kill(-leader, "SIGHUP");
  const gone = await until(() => [leader, ...children].every((p) => !alive(p)), 5000);
  for (const p of [leader, ...children]) if (alive(p)) process.kill(p, "SIGKILL");
  assert.ok(gone, "a process survived SIGHUP");
});
