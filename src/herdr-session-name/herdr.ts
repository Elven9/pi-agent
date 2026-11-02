import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

/** `pi.exec`'s shape, injected so tests can fake herdr. */
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** A herdr CLI call's outcome. `code` is herdr's error code (e.g. "agent_name_taken") when it gave one. */
export type HerdrResult = { ok: true } | { ok: false; code?: string };

/** The metadata source of our sidebar display name (herdr's own pi integration uses "herdr:pi"). */
export const METADATA_SOURCE = "pi-session-name";
/** Per call: herdr answers over a local socket, so a slow call means herdr is stuck or gone. */
export const CALL_TIMEOUT_MS = 1000;

/** The herdr calls the extension makes, all for one pane. None of them throw. */
export interface Herdr {
  /** `herdr pane rename <pane> <label>`, or `--clear` without a label. */
  renamePane(label?: string): Promise<HerdrResult>;
  /** `herdr agent rename <pane> <name>`, or `--clear` without a name. */
  renameAgent(name?: string): Promise<HerdrResult>;
  /** `herdr pane report-metadata`: the sidebar's display name for the pi occupant, or clear it without a name. */
  displayAgent(name: string | undefined, seq: number): Promise<HerdrResult>;
}

/** herdr's error code from its JSON reply (`{"error":{"code":...}}`), on stdout or stderr. */
export function errorCode(result: Pick<ExecResult, "stdout" | "stderr">): string | undefined {
  for (const text of [result.stdout, result.stderr]) {
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const code = (JSON.parse(line) as { error?: { code?: unknown } }).error?.code;
        if (typeof code === "string") return code;
      } catch {
        // not herdr's JSON
      }
    }
  }
  return undefined;
}

/**
 * The herdr CLI for one pane. Values go in as separate arguments: herdr reads a value starting
 * with "-" fine that way, but has no "--" separator and no `--option=value` form.
 */
export function createHerdr(exec: Exec, paneId: string, timeoutMs = CALL_TIMEOUT_MS): Herdr {
  const run = async (args: string[]): Promise<HerdrResult> => {
    try {
      const result = await exec("herdr", args, { timeout: timeoutMs });
      if (result.code === 0 && !result.killed) return { ok: true };
      const code = errorCode(result);
      return code ? { ok: false, code } : { ok: false };
    } catch {
      return { ok: false }; // herdr missing, spawn failure
    }
  };
  return {
    renamePane: (label) => run(["pane", "rename", paneId, ...(label === undefined ? ["--clear"] : [label])]),
    renameAgent: (name) => run(["agent", "rename", paneId, name === undefined ? "--clear" : name]),
    displayAgent: (name, seq) =>
      run([
        "pane",
        "report-metadata",
        paneId,
        "--source",
        METADATA_SOURCE,
        "--agent",
        "pi",
        "--seq",
        String(seq),
        ...(name === undefined ? ["--clear-display-agent"] : ["--display-agent", name]),
      ]),
  };
}
