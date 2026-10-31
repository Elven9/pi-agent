import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTask } from "./task.ts";

async function taskFile(task: object): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "pi-agent-task-")), "task.json");
  await writeFile(path, JSON.stringify(task));
  return path;
}

const base = { taskId: "t", scenario: "s", prompt: "p" };

test("loadTask normalizes tags; none stays none", async () => {
  assert.deepEqual((await loadTask(await taskFile({ ...base, tags: [" Bug", "ui", "bug", ""] }))).tags, ["bug", "ui"]);
  assert.equal((await loadTask(await taskFile(base))).tags, undefined);
});

test("loadTask rejects invalid tags", async () => {
  await assert.rejects(loadTask(await taskFile({ ...base, tags: ["a b"] })), /Invalid task file:\n\/tags Invalid tag "a b"/);
  await assert.rejects(loadTask(await taskFile({ ...base, tags: "a,b" })), /Invalid task file:\n\/tags/);
});
