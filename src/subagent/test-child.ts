import type { ChildExit, ChildHandle, RpcRecord } from "./rpc.ts";

/** Subagent tests only, not part of the extension. */
/** In-memory child: the test drives its events and exit. */
export class FakeChild implements ChildHandle {
  pid = 1;
  requests: Array<{ type: string; fields?: Record<string, unknown> }> = [];
  stopped = 0;
  /** Exits on stop (default) or keeps running until `exitNow`. */
  exitOnStop = true;
  private events: Array<(e: RpcRecord) => void> = [];
  private exits: Array<(e: ChildExit) => void> = [];
  private gone?: ChildExit;
  private waiting: Array<() => void> = [];

  request(type: string, fields?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ type, fields });
    if (this.gone) return Promise.reject(new Error("gone"));
    return Promise.resolve(type === "get_state" ? { sessionFile: "/s/child.jsonl" } : { disposition: "started" });
  }
  onEvent(l: (e: RpcRecord) => void) {
    this.events.push(l);
  }
  onExit(l: (e: ChildExit) => void) {
    this.exits.push(l);
  }
  emit(e: RpcRecord) {
    for (const l of this.events) l(e);
  }
  exitNow(exit: ChildExit = { code: 0, signal: null }) {
    if (this.gone) return;
    this.gone = exit;
    for (const l of this.exits) l(exit);
    for (const w of this.waiting.splice(0)) w();
  }
  stop(): Promise<void> {
    this.stopped++;
    if (this.exitOnStop) this.exitNow({ code: null, signal: "SIGTERM" });
    return this.gone ? Promise.resolve() : new Promise((r) => this.waiting.push(r));
  }
  stderrTail() {
    return "boom on stderr";
  }
  sendResult(status: "ok" | "error", summary: string) {
    this.emit({ type: "tool_execution_end", toolName: "send_to_leader", isError: false, result: { details: { body: { status, summary } } } });
  }
}
