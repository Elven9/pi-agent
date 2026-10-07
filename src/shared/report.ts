import type { ProjectBlockInfo } from "./project.ts";
import type { SubmittedResult } from "./result.ts";

/** `report.json` contract (carried over from agents-core). */
export const REPORT_VERSION = 1;
export const REPORT_FILE = "report.json";

export type RunStatus = "ok" | "error" | "no_result";

export interface RunnerError {
  /** Where it happened, e.g. "setup", "run", "validate". */
  phase: string;
  message: string;
}

export type Phase = "setup" | "run" | "validate";

export interface ToolMetrics {
  calls: number;
  errors: number;
  msP50: number;
  msMax: number;
}

/**
 * A model request that read less from the prompt cache than the previous request had cached.
 * The previous request's cached prompt (`cacheRead + cacheWrite`) is a prefix of this one, so
 * a request normally reads all of it back.
 */
export interface CacheMiss {
  /** 1-based turn of the request. */
  turn: number;
  /** Tokens the previous request had in the cache (its `cacheRead + cacheWrite`). */
  expected: number;
  /** Tokens this request actually read from the cache. */
  cacheRead: number;
}

export interface Metrics {
  wallMs: number;
  phases: Partial<Record<`${Phase}Ms`, number>>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  turns: number;
  model: { calls: number; ttftMsP50: number | null; latencyMsP50: number | null; latencyMsMax: number | null };
  tools: Record<string, ToolMetrics>;
  retries: number;
  compactions: number;
  contextPeakPercent: number | null;
  /**
   * Requests that read under 95% of the expected cached prefix. Not checked for the first
   * request and the first one after a compaction (the prefix changes there by design).
   */
  cacheMisses: CacheMiss[];
}

export interface ToolCallLog {
  id: string;
  tool: string;
  /** 1-based turn the call was made in. */
  turn: number;
  startedAt: string;
  /** null if the call never finished (e.g. pi crashed mid-call). */
  durationMs: number | null;
  isError: boolean | null;
  /** Arguments, with long strings truncated. */
  args: unknown;
  /** Text output of the tool, truncated; images appear as "[image]". null if not finished. */
  output: string | null;
  /** True if `args` or `output` was shortened. The session file has the full data. */
  truncated: boolean;
}

/** Project context in the system prompt (block B), as the wrapper rendered it. */
export interface ProjectContextInfo extends ProjectBlockInfo {
  /** Folder with `project.yaml`; null when only the workspace `AGENTS.md` is used. */
  dir: string | null;
  /** `name` from `project.yaml`; null without a manifest. */
  name: string | null;
}

export interface Report {
  reportVersion: typeof REPORT_VERSION;
  taskId: string;
  scenario: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  result: SubmittedResult | null;
  metrics: Metrics;
  /** null when the prompt has no project context (no manifest and no AGENTS.md). */
  projectContext: ProjectContextInfo | null;
  /** Every tool call of this run, in start order (strings truncated; see the session file). */
  toolCalls: ToolCallLog[];
  session: {
    id: string;
    /** Relative to the out folder (or absolute if outside it); null if not found. */
    file: string | null;
    /** Relative to the out folder (or absolute if outside it); omitted on a fresh run. */
    resumedFrom?: string;
  } | null;
  /** Wrapper-level failures, never thrown away. */
  errors: RunnerError[];
  /** Non-fatal issues (e.g. resuming in a different workdir path). */
  warnings: string[];
}
