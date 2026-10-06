import { readFile } from "node:fs/promises";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";

export interface PreviousSession {
  sessionPath: string;
  header: SessionHeader;
}

/** Reads the header of the session to resume from; throws if it's missing or invalid. */
export async function loadPreviousSession(sessionPath: string): Promise<PreviousSession> {
  let firstLine: string;
  try {
    firstLine = (await readFile(sessionPath, "utf8")).split("\n", 1)[0];
  } catch (err) {
    throw new Error(`Cannot read resume session ${sessionPath}: ${(err as Error).message}`);
  }
  let header: SessionHeader;
  try {
    header = JSON.parse(firstLine);
  } catch {
    throw new Error(`Resume session ${sessionPath} has no valid header`);
  }
  if (header?.type !== "session") throw new Error(`Resume session ${sessionPath} has no session header`);
  return { sessionPath, header };
}

/**
 * Warnings for resuming in `workdir`. Restoring the files to the state the session ended with
 * is the orchestrator's job; the runner can only check that the workdir path is the same,
 * because the transcript contains absolute paths from the previous run.
 */
export function checkResume(prev: PreviousSession, workdir: string): string[] {
  if (prev.header.cwd === workdir) return [];
  return [
    `workdir differs from the previous session (${prev.header.cwd} -> ${workdir}); ` +
      "absolute paths in the transcript will not match",
  ];
}
