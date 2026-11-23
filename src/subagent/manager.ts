import { exitText, type ChildExit, type ChildHandle, type RpcRecord } from "./rpc.ts";
import { PROGRESS_KEEP, type LiveView, progressLine, scenarioLabel } from "./format.ts";
import { abortedResult, baseDetails } from "./records.ts";
import { sessionCost } from "./cost.ts";
import { agentId, messageId, type ResultBody, type ResultDetails, SEND_TO_LEADER, type StartRecord } from "./protocol.ts";

/** States of a live child (design: "States"). Finished children leave the manager. */
export type LiveState = "spawning" | "busy" | "stopping";

/** How a child that is being stopped ends if it sends no result first. */
type Ending = { status: "killed"; by: "user" | "leader" } | { status: "aborted"; reason: string };

interface Live {
  start: StartRecord;
  state: LiveState;
  line: string;
  progress: string[];
  child: ChildHandle;
  sessionFile?: string;
  ending?: Ending;
  result?: ResultDetails;
  exited: boolean;
}

export interface ManagerDeps {
  /** Starts the child process for `start` (scenario, project). */
  startChild(start: StartRecord): ChildHandle;
  /** The prompt sent to the child. */
  prompt(start: StartRecord): string;
  /** A child's final result (normal, failed or killed). Not called for `aborted` (see `shutdown`). */
  onResult(result: ResultDetails): void;
  /** Something shown in the progress display changed. */
  onChange(): void;
  now(): number;
  /** SIGTERM → SIGKILL grace period. */
  graceMs: number;
  /** USD a child's session file records (default: sessionCost). */
  sessionCost?(file: string): number | undefined;
}

/**
 * The leader's live children: process, state, progress (memory only) and the one result each
 * task ends with. A result from the child always wins over `killed`/`aborted` if it arrives
 * before the process is gone; a task never gets two results.
 */
export class SubagentManager {
  private readonly live = new Map<number, Live>();
  private readonly deps: ManagerDeps;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.live.size;
  }

  has(id: number): boolean {
    return this.live.has(id);
  }

  ids(): Set<number> {
    return new Set(this.live.keys());
  }

  /** Live children for the display, in spawn order. */
  views(): LiveView[] {
    return [...this.live.values()].map((l) => ({
      id: agentId(l.start.id),
      scenario: scenarioLabel(l.start.scenario),
      state: l.state,
      task: l.start.task,
      startedAt: l.start.startedAt,
      line: l.line,
      progress: l.progress,
      ...(l.start.restartOf !== undefined && { restartOf: agentId(l.start.restartOf) }),
      ...(l.start.model !== undefined && { model: l.start.model }),
      ...(l.start.thinking !== undefined && { thinking: l.start.thinking }),
    }));
  }

  view(id: number): LiveView | undefined {
    return this.views().find((v) => v.id === agentId(id));
  }

  /** Starts the child and sends it the task. Returns at once; the result comes through `onResult`. */
  spawn(start: StartRecord): void {
    const child = this.deps.startChild(start);
    const live: Live = { start, state: "spawning", line: `starting ${scenarioLabel(start.scenario)}…`, progress: [], child, exited: false };
    this.live.set(start.id, live);
    child.onEvent((event) => this.event(live, event));
    child.onExit((exit) => this.exit(live, exit));
    child.request("prompt", { message: this.deps.prompt(start) }).then(
      () => {
        if (live.state === "spawning") {
          live.state = "busy";
          live.line = "thinking…";
          this.deps.onChange();
        }
      },
      (err: Error) => this.fail(live, `the task was not accepted: ${err.message}`),
    );
    child.request("get_state").then(
      (data) => {
        const file = (data as { sessionFile?: unknown } | undefined)?.sessionFile;
        if (typeof file === "string") live.sessionFile = file;
      },
      () => {},
    );
    this.deps.onChange();
  }

  private event(live: Live, event: RpcRecord): void {
    if (event.type === "tool_execution_start") {
      if (event.toolName === SEND_TO_LEADER) return;
      live.line = progressLine(String(event.toolName), event.args);
      live.progress.push(live.line);
      if (live.progress.length > PROGRESS_KEEP) live.progress.shift();
      if (live.state === "spawning") live.state = "busy";
      this.deps.onChange();
    } else if (event.type === "tool_execution_end" && event.toolName === SEND_TO_LEADER && event.isError !== true) {
      const body = ((event.result as { details?: { body?: ResultBody } } | undefined)?.details)?.body;
      if (body && (body.status === "ok" || body.status === "error")) this.finish(live, body);
    } else if (event.type === "agent_settled") {
      if (!live.result && !live.ending) this.fail(live, `ended without calling ${SEND_TO_LEADER}${event.aborted ? " (aborted)" : ""}`);
    } else if (event.type === "turn_start" || event.type === "message_start") {
      if (live.state === "spawning") {
        live.state = "busy";
        this.deps.onChange();
      }
    }
  }

  private exit(live: Live, exit: ChildExit): void {
    live.exited = true;
    if (!live.result) {
      const ending = live.ending;
      if (ending?.status === "killed") {
        this.finish(live, { status: "killed", reason: ending.by, summary: `killed by ${ending.by}` });
      } else if (ending?.status === "aborted") {
        live.result = this.details(live, { status: "aborted", reason: ending.reason, summary: abortedResult(live.start, ending.reason, 0).envelope.body.summary });
      } else {
        const tail = live.child.stderrTail().trim().split("\n").slice(-5).join("\n");
        this.finish(live, { status: "failed", summary: `the child ${exitText(exit)} without a result${tail ? `\n${tail}` : ""}` });
      }
    }
    this.live.delete(live.start.id);
    this.deps.onChange();
  }

  private fail(live: Live, summary: string): void {
    this.finish(live, { status: "failed", summary });
  }

  private details(live: Live, body: ResultBody): ResultDetails {
    const now = this.deps.now();
    const cost = live.sessionFile ? (this.deps.sessionCost ?? sessionCost)(live.sessionFile) : undefined;
    return {
      ...baseDetails(live.start),
      endedAt: now,
      ...(live.sessionFile && { childSessionFile: live.sessionFile }),
      ...(cost !== undefined && { costUsd: cost }),
      envelope: {
        v: 1,
        id: messageId(now),
        from: `agent:${agentId(live.start.id)}`,
        to: "leader",
        kind: "result",
        reply_to: live.start.taskMessageId,
        ts: Math.floor(now / 1000),
        body,
      },
    };
  }

  /** Records the result (first one wins), reports it, and reaps the process. */
  private finish(live: Live, body: ResultBody): void {
    if (live.result) return;
    live.result = this.details(live, body);
    this.deps.onResult(live.result);
    if (!live.exited) {
      live.state = "stopping";
      live.line = body.status === "ok" || body.status === "error" ? `done · ${body.status}` : body.status === "killed" ? live.line : `failed`;
      void live.child.stop(this.deps.graceMs);
    }
    this.deps.onChange();
  }

  /** Kills a live child; it ends with a `killed` result unless its own result arrives first. */
  async kill(id: number, by: "user" | "leader"): Promise<ResultDetails | undefined> {
    const live = this.live.get(id);
    if (!live) return undefined;
    if (!live.ending && !live.result) {
      live.ending = { status: "killed", by };
      live.state = "stopping";
      live.line = `killed by ${by}`;
      this.deps.onChange();
    }
    await live.child.stop(this.deps.graceMs);
    return live.result;
  }

  /**
   * Session end: stops every child in parallel (SIGTERM, SIGKILL after the grace period) and
   * returns the result of each one that had not reported yet: its own if it arrived meanwhile,
   * else `aborted` with `reason`. These are not passed to `onResult`.
   */
  async shutdown(reason: string): Promise<ResultDetails[]> {
    const all = [...this.live.values()];
    const unreported = all.filter((l) => !l.result);
    for (const l of unreported) {
      l.ending ??= { status: "aborted", reason };
      if (l.ending.status === "killed") l.ending = { status: "aborted", reason };
    }
    // Results arriving while stopping must not be reported through onResult (the session is ending).
    const captured: ResultDetails[] = [];
    const report = this.deps.onResult;
    this.deps.onResult = (r) => captured.push(r);
    try {
      await Promise.all(all.map((l) => l.child.stop(this.deps.graceMs)));
    } finally {
      this.deps.onResult = report;
    }
    const out = new Map<string, ResultDetails>();
    for (const r of captured) out.set(r.agentId, r);
    for (const l of unreported) {
      const r = l.result ?? this.details(l, { status: "aborted", reason, summary: abortedResult(l.start, reason, 0).envelope.body.summary });
      if (!out.has(r.agentId)) out.set(r.agentId, r);
    }
    return [...out.values()];
  }
}
