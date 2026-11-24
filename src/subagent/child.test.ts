import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeSession } from "../tool-ref/test-harness.ts";
import subagent from "./index.ts";
import { SCENARIO_CHANNEL } from "../shared/protocol.ts";
import { detailErrors } from "../shared/result.ts";
import { getScenario } from "../shared/scenarios/index.ts";

/** Records what an extension registers. */
function fakePi() {
  const tools = new Map<string, any>();
  const commands: string[] = [];
  const handlers: string[] = [];
  const listeners = new Map<string, (data: unknown) => void>();
  const pi = {
    registerTool: (t: any) => void tools.set(t.name, t),
    registerCommand: (name: string) => void commands.push(name),
    registerMessageRenderer: () => {},
    on: (event: string) => void handlers.push(event),
    events: { on: (channel: string, fn: (data: unknown) => void) => void listeners.set(channel, fn) },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, handlers, announce: (c: string, d: unknown) => listeners.get(c)?.(d) };
}

test("no nesting: a child registers only codemode and send_to_leader (no leader tools, commands or handlers)", () => {
  const f = fakePi();
  subagent(f.pi, { child: true });
  assert.deepEqual([...f.tools.keys()], ["codemode", "send_to_leader"]);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.handlers, []);
});

test("a child is codemode-only even with codemode.mode \"on\": the model sees codemode and send_to_leader only", async () => {
  const { session, faux } = await makeSession({
    extensions: [(pi) => subagent(pi, { child: true })],
    // send_to_leader listed: a plain-name allowlist drops unlisted extension tools (the CLI child keeps them).
    tools: ["codemode", "read", "bash", "send_to_leader"],
    settings: { codemode: { mode: "on" } },
  });
  let seen: string[] = [];
  faux.setResponses([
    (context) => {
      // Declarations travel in the leading system message; hidden ones are left out.
      seen = ((context.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((t) => t.name);
      return fauxAssistantMessage("ok");
    },
  ]);
  await session.prompt("hi");
  assert.deepEqual(seen.sort(), ["codemode", "send_to_leader"]);
  session.dispose();
});

test("a child records its leader session once as a pi-agent.parent entry; none without the link", async () => {
  const env = { PI_AGENT_PARENT_SESSION: "lead-1", PI_AGENT_PARENT_AGENT: "a3" };
  const { session, sessionManager } = await makeSession({ tools: [], extensions: [(pi) => subagent(pi, { child: true, env })] });
  const parents = () => sessionManager.getEntries().filter((e: any) => e.customType === "pi-agent.parent").map((e: any) => e.data);
  assert.deepEqual(parents(), [{ sessionId: "lead-1", agentId: "a3" }]);
  session.dispose();
  const plain = await makeSession({ tools: [], extensions: [(pi) => subagent(pi, { child: true, env: {} })] });
  assert.equal(plain.sessionManager.getEntries().filter((e: any) => e.customType === "pi-agent.parent").length, 0);
  plain.session.dispose();
});

test("the leader has the leader tools and /agent, and no send_to_leader", () => {
  const f = fakePi();
  subagent(f.pi, { child: false });
  assert.deepEqual([...f.tools.keys()].sort(), ["subagent_get", "subagent_grep", "subagent_kill", "subagent_restart", "subagent_spawn"]);
  assert.deepEqual(f.commands, ["agent"]);
});

test("send_to_leader: the body goes into details, and the run ends", async () => {
  const f = fakePi();
  subagent(f.pi, { child: true });
  const tool = f.tools.get("send_to_leader");
  const r = await tool.execute("c1", { status: "ok", summary: "done" });
  assert.deepEqual(r.details, { body: { status: "ok", summary: "done" } });
  assert.equal(r.terminate, true);
});

test("send_to_leader: detail is checked against the scenario's schema and tagged with its detailKind", async () => {
  const f = fakePi();
  subagent(f.pi, { child: true });
  f.announce(SCENARIO_CHANNEL, { name: "code-writer" });
  const scenario = getScenario("code-writer");
  const tool = f.tools.get("send_to_leader");
  assert.ok(detailErrors(scenario, {}).length > 0, "test premise: {} is not a valid code-writer detail");
  await assert.rejects(tool.execute("c1", { status: "ok", summary: "s", detail: {} }), /Invalid detail:[\s\S]*call send_to_leader again/);
  const noDetail = await tool.execute("c2", { status: "error", summary: "could not" });
  assert.deepEqual(noDetail.details.body, { status: "error", summary: "could not" });
});
