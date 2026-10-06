import { spawn } from "node:child_process";
import { JsonlSplitter, type StreamRecord } from "./events.ts";

export interface PiExit {
  /** Exit code, or null if pi was killed by a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when pi could not be started at all (e.g. ENOENT). */
  spawnError?: string;
  /** Last part of pi's stderr, for error messages. */
  stderrTail: string;
  /** stdout lines that were not valid JSON. */
  badLines: number;
}

export interface RunPiOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** Called for every stdout record as it arrives. */
  onRecord: (record: StreamRecord) => void;
  /** pi's stderr is passed through here (default: our stderr). */
  onStderr?: (chunk: Buffer) => void;
  /** Aborting stops pi: SIGTERM to its process group, SIGKILL after `killGraceMs`. */
  signal?: AbortSignal;
  killGraceMs?: number;
}

const STDERR_TAIL = 4000;

/**
 * Runs pi and streams its JSONL stdout. stdin is closed (pi would prepend piped input to the
 * prompt). pi gets its own process group so stopping it also stops the commands its bash tool
 * started.
 */
export function runPi(o: RunPiOptions): Promise<PiExit> {
  return new Promise((resolvePromise) => {
    let stderrTail = "";
    let badLines = 0;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(o.bin, o.args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });

    const splitter = new JsonlSplitter((line) => {
      let record: StreamRecord;
      try {
        record = JSON.parse(line);
      } catch {
        badLines++;
        return;
      }
      o.onRecord(record);
    });
    // Read continuously: a stalled reader can block pi once the pipe buffer fills.
    child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      (o.onStderr ?? ((c) => process.stderr.write(c)))(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const onAbort = () => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), o.killGraceMs ?? 5000);
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      spawnError = `cannot run ${o.bin}: ${err.message}`;
    });
    // "close" fires after stdout/stderr are drained (also after a spawn error).
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      o.signal?.removeEventListener("abort", onAbort);
      splitter.end();
      resolvePromise({ code, signal, spawnError, stderrTail, badLines });
    });
  });
}
