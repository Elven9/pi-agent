import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { makeSession as makeHarnessSession, type TestSessionOptions } from "../tool-ref/test-harness.ts";
import subagent, { checkModel, childArgs, childCommand } from "./index.ts";
import { ENTRY, SUBAGENT_COMMAND_ENV, type ResultDetails, type StartRecord } from "./protocol.ts";
import { FakeChild } from "./test-child.ts";

const TOOLS = ["subagent_spawn", "subagent_kill", "subagent_restart", "subagent_get", "subagent_grep"];

function makeSession(opts: Partial<TestSessionOptions> = {}) {
  const children = new Map<number, FakeChild>();
  const starts: StartRecord[] = [];
  const made = makeHarnessSession({
    tools: TOOLS,
    extensions: [
      (pi) =>
        subagent(pi, {
          child: false,
          graceMs: 50,
          startChild: (start) => {
            starts.push(start);
            const c = new FakeChild();
            children.set(start.id, c);
            return c;
          },
        }),
    ],
    ...opts,
  });
  return made.then((m) => ({ ...m, children, starts }));
}

const call = (name: string, args: object, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id })], { stopReason: "toolUse" });

/** Entries of the session as `type:customType` / `role`. */
const kinds = (sm: SessionManager) =>
  sm.getBranch().map((e: any) => (e.customType ? `${e.type}:${e.customType}` : e.type === "message" ? `message:${e.message.role}` : e.type));

async function until(check: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("spawn → start record; the child's result becomes a custom message in context and starts a turn", async () => {
  const { session, faux, sessionManager, children, starts } = await makeSession();
  faux.setResponses([call("subagent_spawn", { scenario: "demo", task: "count the files" }, "s1"), fauxAssistantMessage(fauxText("waiting"))]);
  await session.prompt("delegate it");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.id, 1);
  assert.equal(starts[0]!.scenario, "demo");
  const child = children.get(1)!;
  assert.match(String(child.requests[0]!.fields!.message), /^Task from your leader \(you are subagent a1, scenario demo\):\n\ncount the files/);
  const toolResult = sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "toolResult") as any;
  assert.match(toolResult.message.content[0].text, /Started subagent a1 \(demo\)/);

  // The result arrives while the leader is idle: stored as a message and a new turn runs.
  faux.setResponses([fauxAssistantMessage(fauxText("thanks, a1 found 3 files"))]);
  child.sendResult("ok", "3 files");
  await until(() => kinds(sessionManager).at(-1) === "message:assistant" && faux.getPendingResponseCount() === 0);
  await session.agent.waitForIdle?.();
  const k = kinds(sessionManager);
  assert.ok(k.includes("custom:subagent-start"));
  const at = k.indexOf("custom_message:subagent-result");
  assert.ok(at > 0, k.join(","));
  assert.equal(k[at + 1], "message:assistant", "the result started a turn");
  const msg = sessionManager.getBranch()[at] as any;
  assert.match(msg.content, /^\[subagent a1\] demo · ok · \d+s\n3 files$/);
  assert.equal((msg.details as ResultDetails).envelope.body.summary, "3 files");
  // The model saw it: the last request's context has the result text.
  session.dispose();
});

test("spawn without a scenario: a general subagent, no scenario in the start record or the prompt", async () => {
  const { session, faux, sessionManager, children, starts } = await makeSession();
  faux.setResponses([call("subagent_spawn", { task: "read your docs" }, "s1"), fauxAssistantMessage(fauxText("waiting"))]);
  await session.prompt("delegate it");
  assert.equal(starts.length, 1);
  assert.equal("scenario" in starts[0]!, false);
  assert.match(String(children.get(1)!.requests[0]!.fields!.message), /^Task from your leader \(you are subagent a1\):\n\nread your docs/);
  const toolResult = sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "toolResult") as any;
  assert.match(toolResult.message.content[0].text, /Started subagent a1 \(general\)/);
  session.dispose();
});

test("subagent_get / subagent_grep read results from the session; unknown IDs are reported", async () => {
  const { session, faux, children } = await makeSession();
  faux.setResponses([call("subagent_spawn", { scenario: "demo", task: "find the token bug" }, "s1"), fauxAssistantMessage(fauxText("ok"))]);
  await session.prompt("go");
  faux.setResponses([fauxAssistantMessage(fauxText("noted"))]);
  children.get(1)!.sendResult("error", "could not reproduce the token bug");
  await until(() => faux.getPendingResponseCount() === 0);
  await new Promise((r) => setTimeout(r, 50));

  faux.setResponses([
    call("subagent_get", { ids: ["a1", "a9"] }, "g1"),
    call("subagent_grep", { pattern: "token" }, "g2"),
    fauxAssistantMessage(fauxText("done")),
  ]);
  await session.prompt("look it up");
  const results = session.messages.filter((m: any) => m.role === "toolResult").map((m: any) => m.content[0].text);
  const get = results.at(-2)!;
  assert.match(get, /^──── a1 · demo · error · \S+ \(\d+ lines\) ────/);
  assert.match(get, /could not reproduce the token bug/);
  assert.match(get, /a9: no such subagent on this branch/);
  assert.match(results.at(-1)!, /^a1 · demo · error/);
  session.dispose();
});

test("kill by the leader: a killed result, recorded without starting a turn", async () => {
  const { session, faux, sessionManager } = await makeSession();
  faux.setResponses([
    call("subagent_spawn", { scenario: "demo", task: "slow job" }, "s1"),
    call("subagent_kill", { id: "a1" }, "k1"),
    fauxAssistantMessage(fauxText("killed it")),
  ]);
  await session.prompt("go");
  await new Promise((r) => setTimeout(r, 50));
  const k = kinds(sessionManager);
  assert.equal(k.at(-1), "custom_message:subagent-result", "no turn after a kill");
  const d = (sessionManager.getBranch().at(-1) as any).details as ResultDetails;
  assert.equal(d.envelope.body.status, "killed");
  assert.equal(d.envelope.body.reason, "leader");
  const killResult = session.messages.filter((m: any) => m.role === "toolResult").at(-1) as any;
  assert.equal(killResult.content[0].text, "a1: killed by leader.");
  session.dispose();
});

test("restart: a fresh child with a new ID, the same task, and restartOf", async () => {
  const { session, faux, children, starts } = await makeSession();
  faux.setResponses([call("subagent_spawn", { scenario: "demo", task: "flaky job", project: "/p" }, "s1"), fauxAssistantMessage(fauxText("ok"))]);
  await session.prompt("go");
  faux.setResponses([fauxAssistantMessage(fauxText("hm"))]);
  children.get(1)!.exitNow({ code: 1, signal: null });
  await until(() => faux.getPendingResponseCount() === 0);
  await new Promise((r) => setTimeout(r, 50));
  faux.setResponses([call("subagent_restart", { id: "a1" }, "r1"), fauxAssistantMessage(fauxText("restarted"))]);
  await session.prompt("again");
  assert.deepEqual(
    starts.map((s) => [s.id, s.task, s.project, s.restartOf]),
    [
      [1, "flaky job", "/p", undefined],
      [2, "flaky job", "/p", 1],
    ],
  );
  session.dispose();
});

test("/agent restart by the user: a notice in context without a turn; the result says restart and user", async () => {
  const { session, faux, sessionManager, children, starts } = await makeSession();
  faux.setResponses([call("subagent_spawn", { scenario: "demo", task: "list files" }, "s1"), fauxAssistantMessage(fauxText("ok"))]);
  await session.prompt("go");
  faux.setResponses([fauxAssistantMessage(fauxText("noted"))]);
  children.get(1)!.exitNow({ code: 1, signal: null });
  await until(() => faux.getPendingResponseCount() === 0);
  await new Promise((r) => setTimeout(r, 50));

  await session.prompt("/agent restart a1");
  assert.equal(starts.at(-1)!.startedBy, "user");
  assert.equal(starts.at(-1)!.restartOf, 1);
  const k = kinds(sessionManager);
  assert.equal(k.at(-1), "custom_message:subagent-user-start", "no turn started");
  const notice = sessionManager.getBranch().at(-1) as any;
  assert.match(notice.content, /^\[subagent a2\] started by user: restart of a1 \(demo\)\nTask: list files/);

  faux.setResponses([fauxAssistantMessage(fauxText("a2 done"))]);
  children.get(2)!.sendResult("ok", "listed");
  await until(() => faux.getPendingResponseCount() === 0);
  await new Promise((r) => setTimeout(r, 50));
  const result = sessionManager.getBranch().filter((e: any) => e.customType === ENTRY.result).at(-1) as any;
  assert.match(result.content, /^\[subagent a2\] demo · ok · \d+s · restart of a1 · started by user\nlisted/);
  session.dispose();
});

test("subagent_restart by the model: restart of, no notice, not started by user", async () => {
  const { session, faux, sessionManager, children, starts } = await makeSession();
  faux.setResponses([call("subagent_spawn", { scenario: "demo", task: "t" }, "s1"), fauxAssistantMessage(fauxText("ok"))]);
  await session.prompt("go");
  faux.setResponses([fauxAssistantMessage(fauxText("hm"))]);
  children.get(1)!.exitNow({ code: 1, signal: null });
  await until(() => faux.getPendingResponseCount() === 0);
  await new Promise((r) => setTimeout(r, 50));
  faux.setResponses([call("subagent_restart", { id: "a1" }, "r1"), fauxAssistantMessage(fauxText("restarted"))]);
  await session.prompt("again");
  assert.equal(starts.at(-1)!.startedBy, undefined);
  assert.ok(!kinds(sessionManager).includes("custom_message:subagent-user-start"));
  session.dispose();
});

test("session start: tasks left without a result (leader crash) get aborted results, once, and IDs continue", async () => {
  const first = await makeSession();
  first.faux.setResponses([call("subagent_spawn", { scenario: "demo", task: "long job" }, "s1"), fauxAssistantMessage(fauxText("ok"))]);
  await first.session.prompt("go");
  const file = first.sessionManager.getSessionFile()!;
  // A crash: no session_shutdown, the child just disappears with the process.
  const resumed = await makeSession({ root: first.root, sessionManager: SessionManager.open(file) });
  const k = kinds(resumed.sessionManager);
  const results = resumed.sessionManager.getBranch().filter((e: any) => e.customType === ENTRY.result) as any[];
  assert.equal(results.length, 1, k.join(","));
  assert.equal(results[0].details.envelope.body.status, "aborted");
  assert.equal(results[0].details.envelope.body.reason, "leader_exit");
  assert.match(results[0].content, /Task \(demo\):\nlong job/);
  assert.equal(k.at(-1), "custom_message:subagent-result", "no turn started");

  resumed.faux.setResponses([call("subagent_spawn", { scenario: "demo", task: "next" }, "s2"), fauxAssistantMessage(fauxText("ok"))]);
  await resumed.session.prompt("more");
  assert.equal(resumed.starts[0]!.id, 2, "IDs continue after a resume");

  const again = await makeSession({ root: first.root, sessionManager: SessionManager.open(file) });
  const again_ = again.sessionManager.getBranch().filter((e: any) => e.customType === ENTRY.result).map((e: any) => e.details.agentId);
  // a1 is not written again; a2 (left running by the second leader) is now aborted.
  assert.deepEqual(again_, ["a1", "a2"]);
  first.session.dispose();
  resumed.session.dispose();
  again.session.dispose();
});

test("a result that arrives while the leader is busy waits for the run to settle, then starts one turn", async () => {
  const { session, faux, sessionManager, children } = await makeSession();
  faux.setResponses([
    call("subagent_spawn", { scenario: "demo", task: "quick" }, "s1"),
    () => {
      children.get(1)!.sendResult("ok", "quick result");
      return fauxAssistantMessage(fauxText("still working"));
    },
    fauxAssistantMessage(fauxText("got the result")),
  ]);
  await session.prompt("go");
  await until(() => faux.getPendingResponseCount() === 0);
  await new Promise((r) => setTimeout(r, 50));
  const k = kinds(sessionManager);
  assert.deepEqual(k.slice(-3), ["message:assistant", "custom_message:subagent-result", "message:assistant"]);
  const texts = sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "assistant").map((e: any) => e.message.content[0]?.text);
  assert.deepEqual(texts.slice(-2), ["still working", "got the result"]);
  session.dispose();
});

test("session end: children are stopped, results go to subagent-end entries, the next start turns them into messages", async () => {
  const first = await makeSession();
  first.faux.setResponses([
    call("subagent_spawn", { scenario: "demo", task: "one" }, "s1"),
    call("subagent_spawn", { scenario: "demo", task: "two" }, "s2"),
    fauxAssistantMessage(fauxText("ok")),
  ]);
  await first.session.prompt("go");
  await first.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" } as any);
  assert.equal(first.children.get(1)!.stopped, 1);
  assert.equal(first.children.get(2)!.stopped, 1);
  const ends = first.sessionManager.getBranch().filter((e: any) => e.customType === ENTRY.end) as any[];
  assert.deepEqual(ends.map((e) => [e.data.result.agentId, e.data.result.envelope.body.status, e.data.result.envelope.body.reason]), [
    ["a1", "aborted", "reload"],
    ["a2", "aborted", "reload"],
  ]);
  assert.equal(first.sessionManager.getBranch().filter((e: any) => e.customType === ENTRY.result).length, 0, "no messages at shutdown");

  const file = first.sessionManager.getSessionFile()!;
  const next = await makeSession({ root: first.root, sessionManager: SessionManager.open(file) });
  const results = next.sessionManager.getBranch().filter((e: any) => e.customType === ENTRY.result) as any[];
  assert.deepEqual(results.map((e) => [e.details.agentId, e.details.envelope.body.reason]), [
    ["a1", "reload"],
    ["a2", "reload"],
  ]);
  assert.match(results[0].content, /aborted \(reload\)/);
  first.session.dispose();
  next.session.dispose();
});

test("checkModel: exact provider/id of an available model, else an error listing them", () => {
  const available = [{ provider: "anthropic", id: "claude-x" }, { provider: "openai", id: "gpt-x" }];
  assert.equal(checkModel("openai/gpt-x", available), "openai/gpt-x");
  assert.throws(() => checkModel("gpt-x", available), /Unknown or unavailable model "gpt-x".*Available: anthropic\/claude-x, openai\/gpt-x/);
  assert.throws(() => checkModel("x/y", []), /Available: none/);
});

test("spawn with model and thinking: recorded, defaults to the leader's; restart keeps them", async () => {
  const { session, faux, sessionManager, children, starts } = await makeSession();
  const leader = `${session.model!.provider}/${session.model!.id}`;
  // The faux model has no reasoning: the leader runs with thinking off.
  assert.equal(session.thinkingLevel, "off");
  faux.setResponses([
    call("subagent_spawn", { task: "a", model: leader, thinking: "high" }, "s1"),
    call("subagent_spawn", { task: "b" }, "s2"),
    call("subagent_spawn", { task: "c", model: "nope/none" }, "s3"),
    fauxAssistantMessage(fauxText("ok")),
  ]);
  await session.prompt("go");
  assert.deepEqual(starts.map((s) => [s.model, s.thinking]), [[leader, "high"], [leader, "off"]]);
  const results = sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "toolResult") as any[];
  assert.match(results[0].message.content[0].text, /Started subagent a1 \(general, .+, thinking high\)/);
  assert.match(results[2].message.content[0].text, /Unknown or unavailable model "nope\/none"/);

  faux.setResponses([fauxAssistantMessage(fauxText("noted"))]);
  children.get(1)!.sendResult("ok", "done");
  await until(() => faux.getPendingResponseCount() === 0);
  await session.agent.waitForIdle?.();
  faux.setResponses([call("subagent_restart", { id: "a1" }, "r1"), fauxAssistantMessage(fauxText("ok"))]);
  await session.prompt("again");
  assert.deepEqual([starts[2]!.model, starts[2]!.thinking, starts[2]!.restartOf], [leader, "high", 1]);
  session.dispose();
});

test("childCommand and childArgs", () => {
  assert.deepEqual(childCommand({ [SUBAGENT_COMMAND_ENV]: '["node","/x/cli.js"]' }, ["node", "/pi/cli.js"]), ["node", "/x/cli.js"]);
  assert.deepEqual(childCommand({}, ["node", "/pi/cli.js"]), [process.execPath, "/pi/cli.js"]);
  assert.throws(() => childCommand({ [SUBAGENT_COMMAND_ENV]: '"pi"' }), /JSON array/);
  const start: StartRecord = { id: 3, scenario: "debugger", kind: "task", task: "t", project: "/p", startedAt: 0, taskMessageId: "m" };
  assert.deepEqual(childArgs(start, { model: { provider: "anthropic", id: "claude-x" }, thinking: "low" }, "/sessions/x/leader.jsonl"), [
    "--mode", "rpc", "--scenario", "debugger", "--name", "subagent a3 (debugger)",
    "--project", "/p", "--model", "anthropic/claude-x", "--thinking", "low", "--session-dir", "/sessions/x/subagents",
  ]);
  // A recorded model and thinking level win over the leader's.
  assert.deepEqual(childArgs({ ...start, model: "openai/gpt-x", thinking: "high" }, { model: { provider: "anthropic", id: "claude-x" }, thinking: "low" }, undefined).slice(-5), [
    "--model", "openai/gpt-x", "--thinking", "high", "--no-session",
  ]);
  assert.deepEqual(childArgs({ ...start, project: undefined }, {}, undefined).slice(-1), ["--no-session"]);
  // Without a scenario: no --scenario, a general pi agent.
  assert.deepEqual(childArgs({ ...start, scenario: undefined, project: undefined }, {}, undefined), [
    "--mode", "rpc", "--name", "subagent a3 (general)", "--no-session",
  ]);
});
