import { ENTRY as SHARED_ENTRY } from "../shared/protocol.ts";
import { ENTRY, type EndRecord, type ResultDetails, type StartRecord, agentId, messageId } from "./protocol.ts";

/** The parts of a session entry the index reads (pi's `SessionEntry` is structurally wider). */
export interface EntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

/** One subagent as recorded on the active branch. */
export interface Recorded {
  start: StartRecord;
  /** The result message's details, if one was written. */
  result?: ResultDetails;
  /** A result recorded at session end, not yet a message. */
  end?: ResultDetails;
}

/** Subagents on the active branch, by agent number, in spawn order. */
export type SubagentIndex = Map<number, Recorded>;

const isStart = (e: EntryLike): e is EntryLike & { data: StartRecord } =>
  e.type === "custom" && e.customType === ENTRY.start && typeof (e.data as StartRecord | undefined)?.id === "number";

const isEnd = (e: EntryLike): e is EntryLike & { data: EndRecord } =>
  e.type === "custom" && e.customType === ENTRY.end && typeof (e.data as EndRecord | undefined)?.result?.agentId === "string";

const isResult = (e: EntryLike): e is EntryLike & { details: ResultDetails } =>
  e.type === "custom_message" && e.customType === ENTRY.result && typeof (e.details as ResultDetails | undefined)?.agentId === "string";

const numberOf = (id: string): number => Number(id.replace(/^a/, ""));

/** Index of the branch's subagents (`entries`: root to leaf, e.g. `sessionManager.getBranch()`). */
export function indexBranch(entries: readonly EntryLike[]): SubagentIndex {
  const index: SubagentIndex = new Map();
  for (const e of entries) {
    if (isStart(e)) index.set(e.data.id, { start: e.data });
    else if (isEnd(e)) {
      const r = index.get(numberOf(e.data.result.agentId));
      if (r) r.end = e.data.result;
    } else if (isResult(e)) {
      const r = index.get(numberOf(e.details.agentId));
      if (r && !r.result) r.result = e.details;
    }
  }
  return index;
}

/** Highest agent number in the whole session file (all branches), so IDs are never reused. */
export function maxAgentId(entries: readonly EntryLike[]): number {
  let max = 0;
  for (const e of entries) if (isStart(e)) max = Math.max(max, e.data.id);
  return max;
}

/**
 * The worktree the leader has entered (worktree extension: the last `pi-agent.worktree` entry on
 * the branch), so children work in the same folder; undefined when none is entered.
 */
export function enteredWorktree(entries: readonly EntryLike[]): string | undefined {
  let path: string | undefined;
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== SHARED_ENTRY.worktree) continue;
    const p = (e.data as { worktree?: { path?: unknown } } | undefined)?.worktree?.path;
    path = typeof p === "string" ? p : undefined;
  }
  return path;
}

/** The `aborted` result of a task whose leader went away without recording anything. */
export function abortedResult(start: StartRecord, reason: string, now: number): ResultDetails {
  return {
    ...baseDetails(start),
    endedAt: now,
    envelope: {
      v: 1,
      id: messageId(now),
      from: `agent:${agentId(start.id)}`,
      to: "leader",
      kind: "result",
      reply_to: start.taskMessageId,
      ts: Math.floor(now / 1000),
      body: { status: "aborted", reason, summary: abortedSummary(reason) },
    },
  };
}

export function abortedSummary(reason: string): string {
  return reason === "leader_exit" ? "aborted: the leader session ended" : `aborted: the leader session ended (${reason})`;
}

/** Fields every result of `start` shares. */
export function baseDetails(start: StartRecord): Omit<ResultDetails, "endedAt" | "envelope"> {
  return {
    agentId: agentId(start.id),
    resultId: agentId(start.id),
    ...(start.scenario !== undefined && { scenario: start.scenario }),
    kind: "task",
    task: start.task,
    ...(start.project !== undefined && { project: start.project }),
    ...(start.restartOf !== undefined && { restartOf: agentId(start.restartOf) }),
    ...(start.startedBy === "user" && { startedBy: "user" as const }),
    startedAt: start.startedAt,
  };
}

/**
 * Results to write as messages at session start: every task on the branch without a result
 * message gets the result from its `subagent-end` entry, or `aborted` (`leader_exit`) when the
 * leader ended without one (crash, SIGKILL, SIGINT). `live`: agent numbers still running in
 * this process (none after a restart; kept for safety).
 */
export function pendingResults(index: SubagentIndex, now: number, live: ReadonlySet<number> = new Set()): ResultDetails[] {
  const out: ResultDetails[] = [];
  for (const [id, r] of index) {
    if (r.result || live.has(id)) continue;
    out.push(r.end ?? abortedResult(r.start, "leader_exit", now));
  }
  return out;
}
