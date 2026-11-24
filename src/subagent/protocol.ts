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
  /** Custom message (in context): a subagent the user started, so the model knows about it. */
  userStart: "subagent-user-start",
} as const;

/** Who started a subagent: the model (`subagent_spawn`/`subagent_restart`) or the user (`/agent restart`). */
export type StartedBy = "model" | "user";

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

/** pi's thinking levels (`--thinking`). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Data of a `subagent-start` entry, written at spawn. */
export interface StartRecord {
  /** Agent number: `a<id>`. */
  id: number;
  /** Missing: a general subagent (pi's own prompt and tools, no `--scenario`). */
  scenario?: string;
  kind: "task";
  task: string;
  project?: string;
  /** `provider/id` the child runs on (the leader's at spawn unless chosen). Missing in older records: the leader's current one. */
  model?: string;
  /** Thinking level passed with `--thinking` (pi clamps it to the model). The leader's at spawn unless chosen; missing in older records: the leader's current one. */
  thinking?: ThinkingLevel;
  /** Epoch ms. */
  startedAt: number;
  /** Agent number this one restarts. */
  restartOf?: number;
  /** Missing in older records: the model. */
  startedBy?: StartedBy;
  /** Id of the `task` envelope sent to the child. */
  taskMessageId: string;
  /**
   * Session ID of the child (`--session-id`), chosen at spawn: its file is
   * `<leader session dir>/subagents/<timestamp>_<childSessionId>.jsonl`. None when the leader has no
   * session file (the child runs with `--no-session`) and in older records.
   */
  childSessionId?: string;
}

/** `details` of a `subagent-result` message, and the payload of a `subagent-end` entry. */
export interface ResultDetails {
  agentId: string;
  /** Equal to `agentId` in v1; herd results will get a suffix (`a4.2`). */
  resultId: string;
  /** Missing: a general subagent (no scenario). */
  scenario?: string;
  kind: "task";
  task: string;
  project?: string;
  /** From the start record (none in older records). */
  model?: string;
  thinking?: ThinkingLevel;
  restartOf?: string;
  /** Set when the user started it (older records and model starts: none). */
  startedBy?: StartedBy;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  /** From the start record (none without a child session and in older records). */
  childSessionId?: string;
  childSessionFile?: string;
  /** USD the child's session cost up to its result (from childSessionFile); none when unknown or in older records. */
  costUsd?: number;
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
