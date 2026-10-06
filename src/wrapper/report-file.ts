import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPORT_FILE, type Report } from "../shared/report.ts";

/**
 * Removes a report left over from an earlier run in the same out folder (e.g. a copied out
 * folder when resuming), so its presence keeps meaning "this run is done".
 */
export async function clearReport(out: string): Promise<void> {
  const target = join(out, REPORT_FILE);
  await rm(target, { force: true });
  await rm(`${target}.tmp`, { force: true });
}

/**
 * Writes `<out>/report.json` atomically (tmp + rename). Its existence marks the run as done,
 * so this must be the last thing the wrapper writes.
 */
export async function writeReport(out: string, report: Report): Promise<string> {
  await mkdir(out, { recursive: true });
  const target = join(out, REPORT_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(report, null, 2) + "\n", "utf8");
  await rename(tmp, target);
  return target;
}
