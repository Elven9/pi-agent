#!/usr/bin/env node
// A stand-in leader for subagent process tests: starts N real pi children (RPC mode, scripted
// faux model kept busy by slow_tool), prints {"leader": pid, "children": [pid, ...]} once they
// accepted their prompt, then waits. Like the extension, children stay in this process's group
// (no `detached`).
//
//   node testdata/subagent-leader.mjs <n>
import { RpcChild } from "../src/subagent/rpc.ts";
import { childPiArgs } from "./subagent-pi.mjs";

const n = Number(process.argv[2] ?? 2);
const children = Array.from({ length: n }, () => {
  const { args, options } = childPiArgs([{ tool: "slow_tool", args: { ms: 60000 } }]);
  return new RpcChild(process.execPath, args, options);
});
await Promise.all(children.map((c) => c.request("prompt", { message: "go" })));
process.stdout.write(JSON.stringify({ leader: process.pid, children: children.map((c) => c.pid) }) + "\n");
setInterval(() => {}, 1000);
