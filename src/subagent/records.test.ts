import { test } from "node:test";
import assert from "node:assert/strict";
import { indexBranch, maxAgentId, pendingResults, type EntryLike } from "./records.ts";
import { ENTRY, type ResultDetails, type StartRecord } from "./protocol.ts";

const start = (id: number, extra: Partial<StartRecord> = {}): EntryLike => ({
  type: "custom",
  customType: ENTRY.start,
  data: { id, scenario: "review", kind: "task", task: `task ${id}`, startedAt: 1000, taskMessageId: `m${id}`, ...extra } satisfies StartRecord,
});

const details = (id: number, status: ResultDetails["envelope"]["body"]["status"], reason?: string): ResultDetails => ({
  agentId: `a${id}`,
  resultId: `a${id}`,
  scenario: "review",
  kind: "task",
  task: `task ${id}`,
  startedAt: 1000,
  endedAt: 5000,
  envelope: { v: 1, id: "x", from: `agent:a${id}`, to: "leader", kind: "result", ts: 5, body: { status, summary: `s${id}`, ...(reason && { reason }) } },
});

const result = (id: number, status: ResultDetails["envelope"]["body"]["status"] = "ok"): EntryLike => ({
  type: "custom_message",
  customType: ENTRY.result,
  details: details(id, status),
});

const end = (id: number, status: ResultDetails["envelope"]["body"]["status"], reason?: string): EntryLike => ({
  type: "custom",
  customType: ENTRY.end,
  data: { result: details(id, status, reason) },
});

test("index: starts with their result or end record; other entries ignored", () => {
  const idx = indexBranch([start(1), { type: "message" }, start(2), result(1), end(2, "aborted", "reload"), { type: "custom", customType: "other", data: {} }]);
  assert.deepEqual([...idx.keys()], [1, 2]);
  assert.equal(idx.get(1)!.result?.envelope.body.summary, "s1");
  assert.equal(idx.get(2)!.result, undefined);
  assert.equal(idx.get(2)!.end?.envelope.body.reason, "reload");
});

test("maxAgentId: over every entry, so IDs from other branches are not reused", () => {
  assert.equal(maxAgentId([]), 0);
  assert.equal(maxAgentId([start(2), start(7), result(7)]), 7);
});

test("pendingResults: end records become results; tasks with no record at all are aborted (leader_exit); finished and live ones are skipped", () => {
  const idx = indexBranch([start(1), result(1), start(2), end(2, "ok"), start(3), start(4)]);
  const pending = pendingResults(idx, 9000, new Set([4]));
  assert.deepEqual(pending.map((r) => [r.agentId, r.envelope.body.status, r.envelope.body.reason]), [
    ["a2", "ok", undefined],
    ["a3", "aborted", "leader_exit"],
  ]);
  const a3 = pending[1]!;
  assert.equal(a3.task, "task 3");
  assert.equal(a3.endedAt, 9000);
  assert.equal(a3.envelope.reply_to, "m3");
  assert.match(a3.envelope.body.summary, /leader session ended/);
});

test("pendingResults: idempotent once the messages are written", () => {
  const entries = [start(1), start(2)];
  const first = pendingResults(indexBranch(entries), 1);
  const written = first.map((d): EntryLike => ({ type: "custom_message", customType: ENTRY.result, details: d }));
  assert.equal(pendingResults(indexBranch([...entries, ...written]), 2).length, 0);
});

test("a restart keeps the link to the task it restarts", () => {
  const [r] = pendingResults(indexBranch([start(3, { restartOf: 1, project: "/p" })]), 1);
  assert.equal(r!.restartOf, "a1");
  assert.equal(r!.project, "/p");
});
