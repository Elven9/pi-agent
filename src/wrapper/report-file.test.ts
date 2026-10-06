import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../shared/report.ts";
import { clearReport, writeReport } from "./report-file.ts";

test("writeReport writes atomically and clearReport removes it", async () => {
  const out = join(await mkdtemp(join(tmpdir(), "pi-agent-test-")), "nested");
  const report = { reportVersion: 1, taskId: "t", status: "ok" } as Report;
  const path = await writeReport(out, report);
  assert.equal(path, join(out, "report.json"));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), report);
  assert.equal(existsSync(`${path}.tmp`), false);

  await clearReport(out);
  assert.equal(existsSync(path), false);
});
