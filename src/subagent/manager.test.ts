import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentManager } from "./manager.ts";
import type { ResultDetails, StartRecord } from "./protocol.ts";
import type { ChildExit, ChildHandle, RpcRecord } from "./rpc.ts";

/** In-memory child: the test drives its events and exit. */
class FakeChild implements ChildHandle {
  pid = 1;
  requests: Array<{ type: string; fields?: Record<string, unknown> }> = [];
  stopped = 0;
  /** Exits on stop (default) or keeps running until `exitNow`. */
  exitOnStop = true;
  private events: Array<(e: RpcRecord) => void> = [];
  private exits: Array<(e: ChildExit) => void> = [];
  private gone?: ChildExit;
  private waiting: Array<() => void> = [];

  request(type: string, fields?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ type, fields });
    if (this.gone) return Promise.reject(new Error("gone"));
    return Promise.resolve(type === "get_state" ? { sessionFile: "/s/child.jsonl" } : { disposition: "started" });
  }
  onEvent(l: (e: RpcRecord) => void) {
    this.events.push(l);
  }
  onExit(l: (e: ChildExit) => void) {
    this.exits.push(l);
  }
  emit(e: RpcRecord) {
    for (const l of this.events) l(e);
  }
  exitNow(exit: ChildExit = { code: 0, signal: null }) {
    if (this.gone) return;
    this.gone = exit;
    for (const l of this.exits) l(exit);
    for (const w of this.waiting.splice(0)) w();
  }
  stop(): Promise<void> {
    this.stopped++;
    if (this.exitOnStop) this.exitNow({ code: null, signal: "SIGTERM" });
    return this.gone ? Promise.resolve() : new Promise((r) => this.waiting.push(r));
  }
  stderrTail() {
    return "boom on stderr";
  }
  sendResult(status: "ok" | "error", summary: string) {
    this.emit({ type: "tool_execution_end", toolName: "send_to_leader", isError: false, result: { details: { body: { status, summary } } } });
  }
}

function setup() {
  const children = new Map<number, FakeChild>();
  const results: ResultDetails[] = [];
  let changes = 0;
  let t = 1_000_000;
  const manager = new SubagentManager({
    startChild: (s) => {
      const c = new FakeChild();
      children.set(s.id, c);
      return c;
    },
    prompt: (s) => `task: ${s.task}`,
    onResult: (r) => results.push(r),
    onChange: () => changes++,
    now: () => (t += 1000),
    graceMs: 100,
  });
  const start = (id: number, extra: Partial<StartRecord> = {}): StartRecord => ({
    id,
    scenario: "review",
    kind: "task",
    task: `task ${id}`,
    startedAt: 1_000_000,
    taskMessageId: `m${id}`,
    ...extra,
  });
  return { manager, children, results, start, changes: () => changes };
}

const tick = () => new Promise((r) => setImmediate(r));

test("spawn sends the prompt, tracks progress from tool calls, and reports the child's result once", async () => {
  const { manager, children, results, start } = setup();
  manager.spawn(start(1));
  const c = children.get(1)!;
  assert.deepEqual(c.requests.map((r) => r.type), ["prompt", "get_state"]);
  assert.equal(c.requests[0]!.fields!.message, "task: task 1");
  assert.equal(manager.views()[0]!.state, "spawning");
  await tick();
  assert.equal(manager.views()[0]!.state, "busy");

  c.emit({ type: "tool_execution_start", toolName: "codemode", args: { code: "// intent: read the auth code\nreturn 1" } });
  c.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "ls -la" } });
  assert.equal(manager.views()[0]!.line, "bash ls -la");
  assert.deepEqual(manager.views()[0]!.progress, ["read the auth code", "bash ls -la"]);

  c.sendResult("ok", "all good");
  c.emit({ type: "agent_settled", aborted: false });
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.agentId, "a1");
  assert.equal(r.resultId, "a1");
  assert.equal(r.envelope.body.status, "ok");
  assert.equal(r.envelope.reply_to, "m1");
  assert.equal(r.envelope.from, "agent:a1");
  assert.equal(r.childSessionFile, "/s/child.jsonl");
  assert.equal(c.stopped, 1, "the process is reaped after its result");
  assert.equal(manager.size, 0);
});

test("a child that settles without send_to_leader fails", () => {
  const { manager, children, results, start } = setup();
  manager.spawn(start(1));
  children.get(1)!.emit({ type: "agent_settled", aborted: false });
  assert.equal(results[0]!.envelope.body.status, "failed");
  assert.match(results[0]!.envelope.body.summary, /without calling send_to_leader/);
});

test("a child that exits without a result fails, with the exit and stderr in the summary", () => {
  const { manager, children, results, start } = setup();
  manager.spawn(start(1));
  children.get(1)!.exitNow({ code: 3, signal: null });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.envelope.body.status, "failed");
  assert.match(results[0]!.envelope.body.summary, /exited with code 3 without a result\nboom on stderr/);
});

test("kill: a killed result with who killed it; a later result is ignored", async () => {
  const { manager, children, results, start } = setup();
  manager.spawn(start(1));
  const r = await manager.kill(1, "user");
  assert.equal(r?.envelope.body.status, "killed");
  assert.equal(r?.envelope.body.reason, "user");
  children.get(1)!.sendResult("ok", "too late");
  assert.equal(results.length, 1);
  assert.equal(await manager.kill(1, "user"), undefined, "not live anymore");
});

test("kill race: a result that arrives before the process is gone wins", async () => {
  const { manager, children, results, start } = setup();
  manager.spawn(start(1));
  const c = children.get(1)!;
  c.exitOnStop = false;
  const killing = manager.kill(1, "leader");
  c.sendResult("ok", "made it");
  c.exitNow({ code: null, signal: "SIGTERM" });
  const r = await killing;
  assert.equal(r?.envelope.body.status, "ok");
  assert.deepEqual(results.map((x) => x.envelope.body.status), ["ok"]);
});

test("shutdown: unfinished children end aborted with the reason, not through onResult; a result arriving meanwhile wins", async () => {
  const { manager, children, results, start } = setup();
  manager.spawn(start(1));
  manager.spawn(start(2));
  const c2 = children.get(2)!;
  c2.exitOnStop = false;
  const done = manager.shutdown("reload");
  c2.sendResult("error", "partial");
  c2.exitNow();
  const ended = await done;
  assert.equal(results.length, 0);
  const by = Object.fromEntries(ended.map((r) => [r.agentId, r.envelope.body]));
  assert.equal(by.a1!.status, "aborted");
  assert.equal(by.a1!.reason, "reload");
  assert.equal(by.a2!.status, "error");
  assert.equal(manager.size, 0);
});
