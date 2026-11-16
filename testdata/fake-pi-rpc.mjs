#!/usr/bin/env node
// Stand-in for `pi --mode rpc` in subagent tests: answers commands on stdin (JSONL) and plays a
// scripted run after `prompt`. Behaviour from FAKE_RPC (JSON):
//
//   steps        [{ tool, args }]   tool_execution_start events before the result
//   result       { status, summary, detail? } sent as a send_to_leader tool_execution_end;
//                null: settle without a result
//   delayMs      wait before each step (default 10)
//   hang         after the steps, never settle
//   ignoreTerm   ignore SIGTERM (only SIGKILL ends it)
//   crash        exit with this code right after the prompt
//   sessionFile  returned by get_state
//   unicode      a text with U+2028 to put in an event (framing test)
//
// stdin EOF ends the process (code 0), like pi's orderly shutdown.
const spec = JSON.parse(process.env.FAKE_RPC ?? "{}");
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (spec.ignoreTerm) process.on("SIGTERM", () => {});
// Keep the process alive while it waits for commands.
const keepAlive = setInterval(() => {}, 1000);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (spec.ignoreTerm) return; // a stubborn child also ignores EOF
  clearInterval(keepAlive);
  process.exit(0);
});

function handle(cmd) {
  if (cmd.type === "prompt") {
    out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    void run(cmd.message);
  } else if (cmd.type === "get_state") {
    out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionFile: spec.sessionFile ?? "/tmp/child.jsonl" } });
  } else {
    out({ id: cmd.id, type: "response", command: cmd.type, success: true });
  }
}

async function run(message) {
  if (spec.crash !== undefined) {
    process.stderr.write("fake crash\n");
    process.exit(spec.crash);
  }
  out({ type: "agent_start" });
  if (spec.unicode) out({ type: "message_update", text: spec.unicode });
  for (const [i, step] of (spec.steps ?? []).entries()) {
    await sleep(spec.delayMs ?? 10);
    out({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: step.tool, args: step.args ?? {} });
    out({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: step.tool, result: { content: [] }, isError: false });
  }
  if (spec.hang) return;
  await sleep(spec.delayMs ?? 10);
  if (spec.result) {
    out({ type: "tool_execution_start", toolCallId: "r", toolName: "send_to_leader", args: spec.result });
    out({
      type: "tool_execution_end",
      toolCallId: "r",
      toolName: "send_to_leader",
      result: { content: [{ type: "text", text: "Sent to the leader." }], details: { body: spec.result } },
      isError: false,
    });
  }
  out({ type: "agent_end" });
  out({ type: "agent_settled", aborted: false, prompt: message.slice(0, 20) });
}
