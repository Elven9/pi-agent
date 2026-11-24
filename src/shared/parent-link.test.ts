import { test } from "node:test";
import assert from "node:assert/strict";
import { newSessionId, parentHeaders, parentLinkEnv, parentLinkFromEnv, sessionParentLink } from "./parent-link.ts";

test("newSessionId: a UUIDv7 (pi's format; a valid --session-id), time-ordered", () => {
  const a = newSessionId(1_700_000_000_000);
  const b = newSessionId(1_700_000_000_001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.slice(0, 13), "018bcfe5-6800");
  assert.ok(a < b);
  assert.notEqual(newSessionId(5), newSessionId(5));
});

test("parent link: through the environment, both values needed", () => {
  const link = { sessionId: "lead-1", agentId: "a3" };
  assert.deepEqual(parentLinkFromEnv(parentLinkEnv(link)), link);
  assert.equal(parentLinkFromEnv({ PI_AGENT_PARENT_SESSION: "lead-1" }), undefined);
  assert.equal(parentLinkFromEnv({}), undefined);
});

test("sessionParentLink: the last valid pi-agent.parent entry; headers only with a link", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: "pi-agent.parent", data });
  assert.equal(sessionParentLink([{ type: "session", id: "x" }, entry({ sessionId: "" , agentId: "a1" })]), undefined);
  assert.deepEqual(sessionParentLink([entry({ sessionId: "l1", agentId: "a1" }), entry({ sessionId: "l2", agentId: "a2" }), entry(null)]), { sessionId: "l2", agentId: "a2" });
  assert.deepEqual(parentHeaders({ sessionId: "l1", agentId: "a1" }), { "x-pi-parent-session-id": "l1", "x-pi-parent-agent-id": "a1" });
  assert.deepEqual(parentHeaders(undefined), {});
});
