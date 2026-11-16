import { type ChildProcess, spawn } from "node:child_process";

/** One stdout record of `pi --mode rpc`: a command response or a session event. */
export type RpcRecord = { type: string; [key: string]: unknown };

/** What the manager needs from a child process; RpcChild implements it, tests use fakes. */
export interface ChildHandle {
  readonly pid: number | undefined;
  /** Sends a command and resolves with its response's `data`; rejects on `success: false` or exit. */
  request(type: string, fields?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: RpcRecord) => void): void;
  /** Called once when the process is gone (`error` set when it could not start). */
  onExit(listener: (exit: ChildExit) => void): void;
  /** Orderly stop: close stdin + SIGTERM, then SIGKILL after `graceMs`. Resolves on exit. */
  stop(graceMs: number): Promise<void>;
  /** Last stderr output, for failure messages. */
  stderrTail(): string;
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

const STDERR_KEEP = 4000;

/**
 * A `pi --mode rpc` child process: strict LF-only JSONL framing (no `readline`, which also
 * splits on U+2028/U+2029), command/response correlation by ID, events to listeners. The child
 * stays in the leader's process group (no `detached`) and is always signalled by PID.
 */
export class RpcChild implements ChildHandle {
  private readonly proc: ChildProcess;
  private buffer = "";
  private stderr = "";
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
  private readonly eventListeners: Array<(event: RpcRecord) => void> = [];
  private readonly exitListeners: Array<(exit: ChildExit) => void> = [];
  private exit: ChildExit | undefined;
  private readonly exited: Promise<void>;

  constructor(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.proc = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => {
      const done = (exit: ChildExit) => {
        if (this.exit) return;
        this.exit = exit;
        for (const p of this.pending.values()) p.reject(new Error(exitText(exit)));
        this.pending.clear();
        for (const l of this.exitListeners) l(exit);
        resolve();
      };
      this.proc.on("exit", (code, signal) => done({ code, signal }));
      this.proc.on("error", (err) => done({ code: null, signal: null, error: err.message }));
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.read(chunk));
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    // Writes after the child is gone fail with EPIPE; the exit handler reports it.
    this.proc.stdin!.on("error", () => {});
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() === "") continue;
      let record: RpcRecord;
      try {
        record = JSON.parse(line) as RpcRecord;
      } catch {
        continue;
      }
      this.dispatch(record);
    }
  }

  private dispatch(record: RpcRecord): void {
    if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
      const p = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      if (record.success === false) p.reject(new Error(String(record.error ?? `${String(record.command)} failed`)));
      else p.resolve(record.data);
      return;
    }
    for (const l of this.eventListeners) l(record);
  }

  request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.exit) return Promise.reject(new Error(exitText(this.exit)));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(`${JSON.stringify({ ...fields, id, type })}\n`);
    });
  }

  onEvent(listener: (event: RpcRecord) => void): void {
    this.eventListeners.push(listener);
  }

  onExit(listener: (exit: ChildExit) => void): void {
    if (this.exit) listener(this.exit);
    else this.exitListeners.push(listener);
  }

  async stop(graceMs: number): Promise<void> {
    if (this.exit) return;
    this.proc.stdin!.end();
    this.signal("SIGTERM");
    const timer = setTimeout(() => this.signal("SIGKILL"), graceMs);
    await this.exited;
    clearTimeout(timer);
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.exit || this.proc.pid === undefined) return;
    try {
      process.kill(this.proc.pid, signal);
    } catch {
      // Already gone.
    }
  }

  stderrTail(): string {
    return this.stderr;
  }
}

export function exitText(exit: ChildExit): string {
  if (exit.error) return `could not start: ${exit.error}`;
  if (exit.signal) return `exited on ${exit.signal}`;
  return `exited with code ${exit.code}`;
}
