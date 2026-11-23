import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCost, sessionCost } from "./cost.ts";

const usage = (total: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });

test("sessionCost: assistant messages, usage, compaction and branch-summary entries; other entries and bad lines ignored", () => {
  const file = join(mkdtempSync(join(tmpdir(), "subagent-cost-")), "child.jsonl");
  const lines = [
    { type: "session", id: "s" },
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "message", message: { role: "assistant", content: [], usage: usage(0.01) } },
    { type: "message", message: { role: "assistant", content: [], usage: usage(0.02) } },
    { type: "usage", kind: "cache_warm", usage: usage(0.003) },
    { type: "compaction", summary: "s", usage: usage(0.004) },
    { type: "branch_summary", summary: "s", usage: usage(0.005) },
    { type: "custom", customType: "pi-agent.metrics", data: { costUsd: 99 } },
  ].map((l) => JSON.stringify(l));
  writeFileSync(file, [...lines, "{not json", ""].join("\n"));
  assert.ok(Math.abs(sessionCost(file)! - 0.042) < 1e-9);
});

test("sessionCost: undefined for a missing file or one without cost", () => {
  assert.equal(sessionCost("/nonexistent/child.jsonl"), undefined);
  const file = join(mkdtempSync(join(tmpdir(), "subagent-cost-")), "child.jsonl");
  writeFileSync(file, JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }) + "\n");
  assert.equal(sessionCost(file), undefined);
});

test("formatCost: cents, and three decimals below a cent", () => {
  assert.equal(formatCost(0.0641), "$0.06");
  assert.equal(formatCost(1.236), "$1.24");
  assert.equal(formatCost(0.0042), "$0.004");
  assert.equal(formatCost(0), "$0.00");
});
