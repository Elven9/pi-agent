/**
 * Names and record shapes of the subagent extension (docs/subagent-design.md). Shared by the
 * leader side (spawns children, stores results) and the child side (`send_to_leader`).
 */

/** Set to "1" in every child's environment: the extension then registers only `send_to_leader` (no nesting). */
export const SUBAGENT_ENV = "PI_AGENT_SUBAGENT";

/**
 * Optional override of the command that starts a child (JSON array of argv, e.g.
 * `["node", "/path/cli.js"]`). Default: the leader's own pi (`process.execPath` + `process.argv[1]`).
 */
export const SUBAGENT_COMMAND_ENV = "PI_AGENT_SUBAGENT_COMMAND";

/** The only child-side tool: sends the task's result to the leader. */
export const SEND_TO_LEADER = "send_to_leader";

/** Leader tools. */
export const TOOL = {
  spawn: "subagent_spawn",
  kill: "subagent_kill",
  restart: "subagent_restart",
  get: "subagent_get",
  grep: "subagent_grep",
} as const;

/** Session records. `start`/`end`: custom entries (not in context). `result`: custom message (in context). */
export const ENTRY = {
  start: "subagent-start",
  end: "subagent-end",
  result: "subagent-result",
} as const;

/** Widget and status key for the progress display. */
export const UI_KEY = "subagents";

export type ChildStatus = "ok" | "error";
export type LeaderStatus = "killed" | "failed" | "aborted";
export type ResultStatus = ChildStatus | LeaderStatus;

/** Body of a `result` envelope. */
export interface ResultBody {
  status: ResultStatus;
  summary: string;
  /** `aborted`: why (`leader_exit`, `reload`, `new`, `resume`, `fork`). `killed`: `user` or `leader`. */
  reason?: string;
  detailKind?: string;
  detail?: unknown;
}

/** The fixed message envelope (design: "Messages"). v1 uses kinds `task` and `result`. */
export interface Envelope<B = unknown> {
  v: 1;
  id: string;
  from: string;
  to: string;
  kind: "task" | "result" | "control";
  reply_to?: string;
  /** Unix seconds. */
  ts: number;
  body: B;
}

/** Data of a `subagent-start` entry, written at spawn. */
export interface StartRecord {
  /** Agent number: `a<id>`. */
  id: number;
  scenario: string;
  kind: "task";
  task: string;
  project?: string;
  /** Epoch ms. */
  startedAt: number;
  /** Agent number this one restarts. */
  restartOf?: number;
  /** Id of the `task` envelope sent to the child. */
  taskMessageId: string;
}

/** `details` of a `subagent-result` message, and the payload of a `subagent-end` entry. */
export interface ResultDetails {
  agentId: string;
  /** Equal to `agentId` in v1; herd results will get a suffix (`a4.2`). */
  resultId: string;
  scenario: string;
  kind: "task";
  task: string;
  project?: string;
  restartOf?: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  childSessionFile?: string;
  envelope: Envelope<ResultBody>;
}

/** Data of a `subagent-end` entry: a result recorded at session end, turned into a message by the next session start. */
export interface EndRecord {
  result: ResultDetails;
}

export const agentId = (n: number): string => `a${n}`;

/** `a3`, `A3` or `3` -> 3; undefined when not an agent ID. */
export function parseAgentId(text: string): number | undefined {
  const m = /^\s*a?(\d+)\s*$/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? n : undefined;
}

let seq = 0;
/** A message ID, unique within the process. */
export function messageId(now: number = Date.now()): string {
  return `msg_${now.toString(36)}_${(++seq).toString(36)}`;
}
