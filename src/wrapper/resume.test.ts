import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkResume, loadPreviousSession } from "./resume.ts";

const header = { type: "session" as const, id: "p1", timestamp: "", cwd: "/sandbox" };

test("checkResume warns only when the workdir path changed", () => {
  const prev = { sessionPath: "/x/p1.jsonl", header };
  assert.deepEqual(checkResume(prev, "/sandbox"), []);
  const warnings = checkResume(prev, "/elsewhere");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\/sandbox -> \/elsewhere/);
});

test("loadPreviousSession reads the header and rejects invalid files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-test-"));
  const session = join(dir, "p1.jsonl");
  await writeFile(session, JSON.stringify(header) + "\n{}\n");
  assert.deepEqual(await loadPreviousSession(session), { sessionPath: session, header });

  await writeFile(session, "not json\n");
  await assert.rejects(loadPreviousSession(session), /no valid header/);
  await writeFile(session, '{"type":"message"}\n');
  await assert.rejects(loadPreviousSession(session), /no session header/);
  await assert.rejects(loadPreviousSession(join(dir, "missing.jsonl")), /Cannot read/);
});
